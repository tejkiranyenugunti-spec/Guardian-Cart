// Voice for Rosa's tablet.
// Speaking: Cartesia TTS via our server; falls back to the browser's speech synthesis. Captions are always on screen.
// Listening: push-to-talk. Cartesia STT via our server; falls back to browser speech recognition; typed input always works.
import { useCallback, useEffect, useRef, useState } from "react";

let current: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
const listeners = new Set<(s: boolean) => void>();
let speakingNow = false;
let speakToken = 0;
const setSpeaking = (v: boolean) => {
  speakingNow = v;
  listeners.forEach((l) => l(v));
};

export function stopSpeaking() {
  speakToken++;
  if (current) {
    current.pause();
    current = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  setSpeaking(false);
}

function pickBrowserVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const pref = ["Samantha", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Karen", "Moira"];
  for (const p of pref) {
    const v = voices.find((x) => x.name.includes(p));
    if (v) return v;
  }
  return voices.find((v) => v.lang?.startsWith("en")) ?? null;
}

export type SpeakResult = "cartesia" | "browser" | "blocked" | "none";

export async function speak(text: string, opts: { cartesia: boolean }): Promise<SpeakResult> {
  stopSpeaking();
  const token = ++speakToken;
  if (opts.cartesia) {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok && token === speakToken) {
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        current = audio;
        currentUrl = url;
        audio.onended = () => token === speakToken && setSpeaking(false);
        audio.onerror = () => token === speakToken && setSpeaking(false);
        try {
          setSpeaking(true);
          await audio.play();
          return "cartesia";
        } catch {
          setSpeaking(false);
          return "blocked";
        }
      }
    } catch {
      /* fall through to browser speech */
    }
  }
  if (token !== speakToken) return "none";
  if ("speechSynthesis" in window) {
    // Queue one utterance per sentence: Chrome can cut off long single utterances.
    const parts = text.match(/[^.!?]+[.!?]*/g)?.map((p) => p.trim()).filter(Boolean) ?? [text];
    const v = pickBrowserVoice();
    parts.forEach((part, i) => {
      const u = new SpeechSynthesisUtterance(part);
      u.rate = 0.86;
      u.pitch = 1;
      if (v) u.voice = v;
      if (i === 0) u.onstart = () => token === speakToken && setSpeaking(true);
      if (i === parts.length - 1) {
        u.onend = () => token === speakToken && setSpeaking(false);
      }
      u.onerror = () => token === speakToken && setSpeaking(false);
      window.speechSynthesis.speak(u);
    });
    return "browser";
  }
  return "none";
}

export function useSpeaking() {
  const [s, setS] = useState(speakingNow);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

// ------------------------------------------------------------------ push-to-talk

type SR = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function getSR(): (new () => SR) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export type MicMode = "cartesia" | "browser" | "none";

export function usePushToTalk(opts: { cartesia: boolean; onText: (t: string) => void; onError: (m: string) => void }) {
  const mode: MicMode = opts.cartesia && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices ? "cartesia" : getSR() ? "browser" : "none";
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [interim, setInterim] = useState("");
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const sr = useRef<SR | null>(null);
  const finalText = useRef("");
  const heardText = useRef("");
  const startedAt = useRef(0);
  const cb = useRef(opts);
  cb.current = opts;

  const start = useCallback(async () => {
    if (listening) return;
    stopSpeaking();
    startedAt.current = Date.now();
    setInterim("");
    if (mode === "cartesia") {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
        const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        chunks.current = [];
        r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
        r.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          const held = Date.now() - startedAt.current;
          const blob = new Blob(chunks.current, { type: r.mimeType || "audio/webm" });
          if (held < 500 || blob.size < 1000) {
            cb.current.onError("Hold the button down while you talk, then let go.");
            return;
          }
          setTranscribing(true);
          try {
            const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": blob.type.split(";")[0] }, body: blob, signal: AbortSignal.timeout(15000) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json.text) throw new Error(json.error || "I didn't catch that.");
            cb.current.onText(json.text);
          } catch (e) {
            cb.current.onError(`${(e as Error).message} You can tap an answer or type it instead.`);
          } finally {
            setTranscribing(false);
          }
        };
        r.start(250);
        rec.current = r;
        setListening(true);
      } catch {
        cb.current.onError("I can't use the microphone. Please tap an answer or type it.");
      }
      return;
    }
    if (mode === "browser") {
      const Ctor = getSR()!;
      const r = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.lang = "en-US";
      finalText.current = "";
      heardText.current = "";
      r.onresult = (e) => {
        let fin = "";
        let mid = "";
        for (let i = 0; i < e.results.length; i++) {
          const res = e.results[i];
          if (res.isFinal) fin += res[0].transcript;
          else mid += res[0].transcript;
        }
        finalText.current = fin;
        heardText.current = (fin + " " + mid).trim();
        setInterim(heardText.current);
      };
      r.onerror = (e) => {
        if (e.error !== "aborted" && e.error !== "no-speech") cb.current.onError("Voice didn't work this time. Please tap an answer or type it.");
      };
      r.onend = () => {
        setListening(false);
        const text = (finalText.current || heardText.current || "").trim();
        sr.current = null;
        if (text) cb.current.onText(text);
        else if (Date.now() - startedAt.current > 400) cb.current.onError("I didn't catch that. Please try again, or tap an answer.");
      };
      try {
        r.start();
        sr.current = r;
        setListening(true);
      } catch {
        cb.current.onError("I can't use the microphone. Please tap an answer or type it.");
      }
    }
  }, [listening, mode]);

  const stop = useCallback(() => {
    if (rec.current && rec.current.state !== "inactive") {
      rec.current.stop();
      rec.current = null;
      setListening(false);
    }
    if (sr.current) {
      // Use interim text if final hasn't arrived yet.
      const r = sr.current;
      setTimeout(() => r.stop(), 350);
    }
  }, []);

  useEffect(() => () => {
    rec.current?.stop();
    sr.current?.abort();
  }, []);

  return { mode, listening, transcribing, interim, start, stop };
}
