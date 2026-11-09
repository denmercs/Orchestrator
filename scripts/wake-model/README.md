# Wake model: "hey sulti"

`train.sh` builds the acoustic wake word classifier the Mac's hands-free wake uses (`client/voice-ears.ts`). It trains
an openWakeWord classifier (16 embeddings in, one score out) on synthetic Piper speech of "hey sulti" and "sulti"
against openWakeWord's precomputed negative features, and installs it as
`$HOME/.orchestrator/voice/models/wake/hey_sulti.onnx`.

## Why it is not in the repo

The repo is public and openWakeWord's training data is licensed non-commercial (CC BY-NC-SA). The built model is
therefore kept in the local cache only, never committed and never downloaded by the plugin. If it is missing, the voice
door says to run this script. Shipping a model would need a rights check with legal first.

## Run

```
scripts/wake-model/train.sh
```

Needs `uv`, `git`, `curl` and about 60 GB free (30-40 GB of downloads). Use `nohup scripts/wake-model/train.sh &` to run
it in the background. Work dir and logs: `$HOME/.orchestrator/voice/wake-train/` (`logs/train.log`). Re-running skips
finished stages (markers in `.done/`), resumes downloads and clip generation, and does nothing once the model is
installed. Delete `.done/<stage>` to redo one stage; delete `out/` too to regenerate.

`hey_sulti.yml` is the training config (about 20k clips, 25k steps). The script writes a copy with `$HOME` expanded,
since the YAML loader does not expand it.

## How long

Hours on an Apple Silicon Mac with no CUDA: clip generation is the slow part, then augmentation and training.

## Check it

The script ends by loading the file with `onnxruntime` (input `[1, 16, 96]`, one score) and prints the training's
report; to see it again: `grep -E 'Final Model|best model' $HOME/.orchestrator/voice/wake-train/logs/train.log`
(recall, accuracy and false accepts per hour on the validation set). Then try it by saying "hey Sulti" near the Mac.
