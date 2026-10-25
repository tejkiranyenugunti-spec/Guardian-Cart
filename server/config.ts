import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// app/.env first, then repo-root .env (neither is committed).
loadEnv({ path: path.join(here, "..", ".env"), quiet: true });
loadEnv({ path: path.join(here, "..", "..", ".env"), quiet: true });

const env = (k: string) => (process.env[k] ?? "").trim();

export const CONFIG = {
  port: Number(env("PORT") || 8787),
  // Force every external service off (rehearsal / airplane mode). The whole flow still runs.
  offline: env("GUARDIANCART_OFFLINE") === "1",
  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY"),
    // Fast model writes the spoken question (latency budget ~2 s).
    fastModel: env("CLAUDE_FAST_MODEL") || "claude-haiku-5-5",
    // Reasoning model reads Rosa's answer and produces the structured risk signal.
    reasoningModel: env("CLAUDE_REASONING_MODEL") || "claude-sonnet-5-5",
    questionTimeoutMs: Number(env("CLAUDE_QUESTION_TIMEOUT_MS") || 2500),
    assessTimeoutMs: Number(env("CLAUDE_ASSESS_TIMEOUT_MS") || 7000),
  },
  cartesia: {
    apiKey: env("CARTESIA_API_KEY"),
    version: env("CARTESIA_VERSION") || "2026-08-14",
    ttsModel: env("CARTESIA_TTS_MODEL") || "sonic-3.6",
    sttModel: env("CARTESIA_STT_MODEL") || "ink-whisper",
    voiceId: env("CARTESIA_VOICE_ID") || "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
    speed: Number(env("CARTESIA_SPEED") || 0.85),
    timeoutMs: Number(env("CARTESIA_TIMEOUT_MS") || 6000),
  },
  moss: {
    projectId: env("MOSS_PROJECT_ID"),
    projectKey: env("MOSS_PROJECT_KEY"),
    index: env("MOSS_INDEX") || "guardiancart-rosa",
    timeoutMs: Number(env("MOSS_TIMEOUT_MS") || 4000),
  },
};

export const hasClaude = () => !CONFIG.offline && Boolean(CONFIG.anthropic.apiKey || process.env.ANTHROPIC_AUTH_TOKEN);
export const hasCartesia = () => !CONFIG.offline && Boolean(CONFIG.cartesia.apiKey);
export const hasMoss = () => !CONFIG.offline && Boolean(CONFIG.moss.projectId && CONFIG.moss.projectKey);

/** Race a promise against a timeout. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
