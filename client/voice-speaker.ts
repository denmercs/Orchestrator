// Binds the sentence player to the plugin: `render` is the server Speaker (orchestration.voice.speak) and `play` is the
// client's own playAudio, so the same code speaks on the Mac and, behind voice.phoneAudio, on the phone.
import { voiceSpeak } from "../shared/voice-rpc";
import { createSentencePlayer } from "./voice-speaker-model";

type Rpc = (rpc: typeof voiceSpeak, input: { text: string; replyId: string }) => Promise<{ audio: string; engine: "chatterbox" | "kokoro" | "loading" }>;
type PlayAudio = (source: { base64: string; mimeType: string }) => Promise<void>;

export function createVoiceSpeaker(rpc: Rpc, playAudio: PlayAudio) {
  return createSentencePlayer({
    render: (text, replyId) => rpc(voiceSpeak, { text, replyId }),
    play: (base64) => playAudio({ base64, mimeType: "audio/wav" }),
  });
}
