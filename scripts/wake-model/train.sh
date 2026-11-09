#!/usr/bin/env bash
# Builds the "hey sulti" wake word classifier with openWakeWord's training pipeline and copies it to the local
# cache the voice door reads. Long (hours) and idempotent: each finished stage leaves a marker and is skipped on re-run.
# See README.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$HOME/.orchestrator/voice/wake-train"
MODEL_DIR="$HOME/.orchestrator/voice/models/wake"
RESULT="$MODEL_DIR/hey_sulti.onnx"

OWW_TAG="v0.6.0"            # openWakeWord release with openwakeword/train.py
OWW_MODELS_TAG="v0.5.1"     # release that carries the shared melspectrogram/embedding models
PIPER_TAG="v2.0.0"          # piper-sample-generator release the OWW notebook was written against
PIPER_VOICE_URL="https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt"
HF="https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main"
# DeepPhonemizer's own host now refuses the download, and openWakeWord would save that error page as the model.
# This mirror's pickle was inspected (it only imports torch tensor rebuilds, set, OrderedDict and dp tokenizers).
PHONEMIZER_URL="https://huggingface.co/TaterTotterson/DeepPhonemizer/resolve/main/en_us_cmudict_forward.pt"
PHONEMIZER_SHA256="c2e1fb223d7e027bf7b33052540c6f71d19db6d7fd87ab8671152b8b114501c2"
AUDIOSET_URL="https://huggingface.co/datasets/agkphysics/AudioSet/resolve/main/data/bal_train/09.parquet"

SRC="$WORK/src"; DATA="$WORK/data"; OUT="$WORK/out"; LOGS="$WORK/logs"; DONE="$WORK/.done"
VENV="$WORK/venv"; PY="$VENV/bin/python"
YML="$WORK/hey_sulti.yml"
OWW="$SRC/openwakeword"; PIPER="$SRC/piper-sample-generator"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { printf 'train.sh: %s\n' "$*" >&2; exit 1; }
stage() { [ -e "$DONE/$1" ]; }
mark() { touch "$DONE/$1"; }

# Checks that fail clearly on bad setup, before anything is downloaded.
[ -n "${HOME:-}" ] || die "HOME is not set"
[ -f "$HERE/hey_sulti.yml" ] || die "missing $HERE/hey_sulti.yml"
for tool in uv git curl tar; do command -v "$tool" >/dev/null || die "$tool not found on PATH (brew install $tool)"; done
mkdir -p "$WORK" "$DONE" "$LOGS" "$SRC" "$DATA" "$OUT" "$MODEL_DIR"
avail_gb=$(df -g "$WORK" | awk 'NR==2 {print $4}')
if [ ! -e "$DONE/downloads" ] && [ "${avail_gb:-0}" -lt 60 ]; then
  die "only ${avail_gb} GB free under $WORK; the downloads and clips need about 60 GB"
fi

# Everything below is logged to the work dir as well as the terminal.
exec > >(tee -a "$LOGS/train.log") 2>&1
log "work dir $WORK"

if [ -f "$RESULT" ] && stage verified; then
  log "already built and verified: $RESULT"; exit 0
fi

# 1. Python 3.10 venv, pinned openWakeWord + training dependencies.
if ! stage env; then
  log "creating the Python 3.10 environment"
  [ -d "$OWW/.git" ] || git clone --depth 1 --branch "$OWW_TAG" https://github.com/dscripka/openWakeWord "$OWW"
  [ -d "$PIPER/.git" ] || git clone --depth 1 --branch "$PIPER_TAG" https://github.com/rhasspy/piper-sample-generator "$PIPER"
  uv venv --python 3.10 "$VENV"
  # piper-phonemize 1.1.0 has no macOS arm64 wheel; the -cross build ships the same piper_phonemize module.
  # tensorflow/onnx_tf are left out: train.py only uses them for the optional .tflite export after the .onnx is saved.
  uv pip install --python "$PY" -e "$OWW" \
    piper-phonemize-cross==1.2.1 webrtcvad pyyaml numpy"<2" torch==2.1.2 torchaudio==2.1.2 \
    mutagen==1.47.0 torchinfo==1.8.0 torchmetrics==1.2.0 speechbrain==0.5.14 audiomentations==0.33.0 \
    torch-audiomentations==0.11.0 acoustics==0.2.6 pronouncing==0.2.0 datasets==2.14.6 deep-phonemizer==0.0.19 \
    scipy soundfile librosa onnx onnxruntime "pyarrow<15" "setuptools<81"
  mark env
fi

# 2. Downloads (curl resumes a partial file on re-run).
fetch() { # url dest
  [ -s "$2" ] && [ ! -e "$2.part" ] && return 0
  log "downloading $(basename "$2")"
  curl -fL --retry 5 -C - -o "$2.part" "$1" || die "download failed: $1 (the dataset URL may have moved)"
  mv "$2.part" "$2"
}
if ! stage downloads; then
  fetch "$PIPER_VOICE_URL" "$PIPER/models/en_US-libritts_r-medium.pt"
  mkdir -p "$OWW/openwakeword/resources/models"
  for m in embedding_model.onnx melspectrogram.onnx embedding_model.tflite melspectrogram.tflite; do
    fetch "https://github.com/dscripka/openWakeWord/releases/download/$OWW_MODELS_TAG/$m" "$OWW/openwakeword/resources/models/$m"
  done
  fetch "$HF/validation_set_features.npy" "$DATA/validation_set_features.npy"
  fetch "$HF/openwakeword_features_ACAV100M_2000_hrs_16bit.npy" "$DATA/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
  fetch "$AUDIOSET_URL" "$DATA/bal_train09.parquet"
  PHONEMIZER="$OWW/openwakeword/resources/en_us_cmudict_forward.pt"
  [ "$(shasum -a 256 "$PHONEMIZER" 2>/dev/null | cut -d' ' -f1)" = "$PHONEMIZER_SHA256" ] || rm -f "$PHONEMIZER"
  fetch "$PHONEMIZER_URL" "$PHONEMIZER"
  [ "$(shasum -a 256 "$PHONEMIZER" | cut -d' ' -f1)" = "$PHONEMIZER_SHA256" ] || die "$PHONEMIZER does not match the pinned checksum"

  # MIT room impulse responses, AudioSet and Free Music Archive background audio, as 16 kHz 16-bit wav.
  if [ ! -e "$DONE/audio-prepared" ]; then
    log "preparing room impulse responses and background audio"
    "$PY" -I - "$DATA" <<'PYEOF'
import sys, os
from pathlib import Path
import numpy as np, scipy.io.wavfile, datasets
from tqdm import tqdm

data = Path(sys.argv[1])

def save(path, array):
    scipy.io.wavfile.write(path, 16000, (array * 32767).astype(np.int16))

rirs = data / "mit_rirs"; rirs.mkdir(exist_ok=True)
for row in tqdm(datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True)):
    save(rirs / row["audio"]["path"].split("/")[-1], row["audio"]["array"])

out = data / "audioset_16k"; out.mkdir(exist_ok=True)
# Read the parquet with pyarrow: the pinned datasets release cannot parse this file's feature metadata.
import io, librosa, pyarrow.parquet as pq, soundfile as sf
count = 0
for batch in pq.ParquetFile(data / "bal_train09.parquet").iter_batches(batch_size=50, columns=["audio"]):
    for clip in batch.column("audio").to_pylist():  # the first 1000 clips are plenty of background noise
        wave, rate = sf.read(io.BytesIO(clip["bytes"]), dtype="float32")
        if wave.ndim > 1:
            wave = wave.mean(axis=1)
        save(out / f"audioset_{count:04d}.wav", librosa.resample(wave, orig_sr=rate, target_sr=16000))
        count += 1
        if count >= 1000:
            break
    if count >= 1000:
        break

fma = data / "fma"; fma.mkdir(exist_ok=True)
stream = iter(datasets.load_dataset("rudraml/fma", name="small", split="train", streaming=True)
              .cast_column("audio", datasets.Audio(sampling_rate=16000)))
for _ in tqdm(range(3600 // 30)):  # one hour of 30 second clips
    row = next(stream)
    save(fma / os.path.basename(row["audio"]["path"]).replace(".mp3", ".wav"), row["audio"]["array"])
PYEOF
    for d in mit_rirs audioset_16k fma; do
      [ -n "$(ls -A "$DATA/$d" 2>/dev/null)" ] || die "no audio was prepared in $DATA/$d"
    done
    rm -f "$DATA/bal_train09.parquet"
    mark audio-prepared
  fi
  mark downloads
fi

# 3. Render the config: the YAML loader does not expand $HOME, so substitute it here.
sed "s|\$HOME|$HOME|g" "$HERE/hey_sulti.yml" > "$YML"
grep -q '\$HOME' "$YML" && die "unexpanded \$HOME left in $YML"

# 4. generate -> augment -> train (train.py resumes generation and skips finished augmentation itself).
# macOS starts DataLoader workers with spawn, which cannot pickle the lambdas in train.py, and fork deadlocks once torch
# has started threads. Load the batches in the training process instead (idempotent edit of the cloned source).
sed -i.bak 's/num_workers=n_cpus, prefetch_factor=16/num_workers=0/' "$OWW/openwakeword/train.py"
grep -q 'num_workers=0' "$OWW/openwakeword/train.py" || die "could not patch the DataLoader in $OWW/openwakeword/train.py"
train() { "$PY" "$OWW/openwakeword/train.py" --training_config "$YML" "$@"; }
if ! stage generate; then log "stage: generate clips (Piper, slow on CPU)"; train --generate_clips; mark generate; fi
if ! stage augment;  then log "stage: augment clips";                       train --augment_clips;  mark augment;  fi
if ! stage train; then
  log "stage: train model"
  # train.py ends with a .tflite export that needs tensorflow; the .onnx is written first, so tolerate only that.
  train --train_model || [ -f "$OUT/hey_sulti.onnx" ] || die "training failed, see $LOGS/train.log"
  [ -f "$OUT/hey_sulti.onnx" ] || die "training finished but wrote no $OUT/hey_sulti.onnx"
  mark train
fi

# 5. Verify the model loads and has the shape the voice door feeds, then install it.
"$PY" -I - "$OUT/hey_sulti.onnx" <<'PYEOF'
import sys, numpy as np, onnxruntime as ort
s = ort.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"])
i, o = s.get_inputs(), s.get_outputs()
assert len(i) == 1 and list(i[0].shape[1:]) == [16, 96], f"bad input {[x.shape for x in i]}"
assert len(o) == 1, f"expected one output, got {len(o)}"
r = s.run(None, {i[0].name: np.zeros((1, 16, 96), np.float32)})[0]
assert r.size == 1 and 0.0 <= float(r.ravel()[0]) <= 1.0, f"bad score {r}"
print("model ok: input", i[0].shape, "output", o[0].shape, "score on silence", float(r.ravel()[0]))
PYEOF
cp "$OUT/hey_sulti.onnx" "$RESULT"
mark verified
log "installed $RESULT"
log "training report: grep -E 'Final Model|best model' $LOGS/train.log"
