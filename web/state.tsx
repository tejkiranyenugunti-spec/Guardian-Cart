import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppState } from "../shared/types";

interface Ctx {
  state?: AppState;
  connected: boolean;
  error?: string;
  household: string;
}
const StateCtx = createContext<Ctx>({ connected: false, household: "home" });

export function StateProvider({ children, household = "home" }: { children: ReactNode; household?: string }) {
  const [state, setState] = useState<AppState>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const retry = useRef(0);

  useEffect(() => {
    let es: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      es = new EventSource(`/api/${household}/events`);
      es.onopen = () => {
        retry.current = 0;
        setConnected(true);
        setError(undefined);
      };
      es.onmessage = (ev) => {
        try {
          setState(JSON.parse(ev.data));
        } catch {
          /* ignore malformed frame */
        }
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (closed) return;
        retry.current++;
        setError(retry.current > 2 ? "Reconnecting to GuardianCart…" : undefined);
        timer = setTimeout(connect, Math.min(4000, 500 * retry.current));
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (timer) clearTimeout(timer);
    };
  }, [household]);

  return <StateCtx.Provider value={{ state, connected, error, household }}>{children}</StateCtx.Provider>;
}

export const useAppState = () => useContext(StateCtx);

/** API bound to the current household: useApi()("/why") -> POST /api/<household>/why */
export function useApi() {
  const { household } = useContext(StateCtx);
  return <T = { ok: boolean },>(path: string, body?: unknown, timeoutMs?: number) => api<T>(`/${household}${path}`, body, timeoutMs);
}

export async function api<T = { ok: boolean }>(path: string, body?: unknown, timeoutMs = 20000): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((e) => {
    throw new Error(e?.name === "TimeoutError" ? "That took too long. Please try again." : "Can't reach GuardianCart. Check the connection.");
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Something went wrong. Please try again.");
  return json as T;
}

export const fmtMoney = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: n % 1 === 0 ? 0 : 2 });
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
export const fmtDay = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
