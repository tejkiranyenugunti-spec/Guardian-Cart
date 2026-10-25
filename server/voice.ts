// Cartesia TTS / STT proxy. The browser never sees the API key.
import { CONFIG, hasCartesia } from "./config";

export class VoiceUnavailable extends Error {}

export async function synthesize(text: string): Promise<Buffer> {
  if (!hasCartesia()) throw new VoiceUnavailable("Cartesia not configured");
  const res = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    signal: AbortSignal.timeout(CONFIG.cartesia.timeoutMs),
    headers: {
      Authorization: `Bearer ${CONFIG.cartesia.apiKey}`,
      "Cartesia-Version": CONFIG.cartesia.version,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model_id: CONFIG.cartesia.ttsModel,
      transcript: text,
      voice: { id: CONFIG.cartesia.voiceId },
      language: "en",
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      // Slow, calm and clear for an older listener.
      generation_config: { speed: CONFIG.cartesia.speed, volume: 1, emotion: "calm" },
    }),
  });
  if (!res.ok) throw new Error(`Cartesia TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  if (!hasCartesia()) throw new VoiceUnavailable("Cartesia not configured");
  const ext = mime.includes("ogg") ? "ogg" : mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), `answer.${ext}`);
  form.append("model", CONFIG.cartesia.sttModel);
  form.append("language", "en");
  const res = await fetch("https://api.cartesia.ai/stt", {
    method: "POST",
    signal: AbortSignal.timeout(CONFIG.cartesia.timeoutMs + 4000),
    headers: { Authorization: `Bearer ${CONFIG.cartesia.apiKey}`, "Cartesia-Version": CONFIG.cartesia.version },
    body: form,
  });
  if (!res.ok) throw new Error(`Cartesia STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
