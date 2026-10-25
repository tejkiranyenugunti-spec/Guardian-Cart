import { useEffect, useRef, type ReactNode } from "react";
import type { TimelineEvent, TxnStatus } from "../shared/types";
import { fmtTime } from "./state";

type IconName = "shield" | "phone" | "card" | "check" | "pause" | "mic" | "speaker" | "x" | "alert" | "user" | "store" | "chat" | "lock" | "heart" | "sparkle" | "memory" | "rules" | "refresh" | "keyboard" | "question" | "stop";

const PATHS: Record<IconName, ReactNode> = {
  shield: <path d="M12 3l7 2.6v5.6c0 4.4-3 8.2-7 9.8-4-1.6-7-5.4-7-9.8V5.6z" />,
  phone: <path d="M6.6 3.5h2.6l1.5 4-2 1.3a11 11 0 005.5 5.5l1.3-2 4 1.5v2.6a2 2 0 01-2.2 2A16.5 16.5 0 014.6 5.7a2 2 0 012-2.2z" />,
  card: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  pause: <path d="M9 6v12M15 6v12" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" />
    </>
  ),
  speaker: <path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  alert: <path d="M12 4l9 16H3zM12 10v4.5M12 17.2v.3" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.5 20a7.5 7.5 0 0115 0" />
    </>
  ),
  store: <path d="M4 9.5L5.5 4h13L20 9.5M4 9.5h16M4 9.5a2.7 2.7 0 005.3 0 2.7 2.7 0 005.4 0 2.7 2.7 0 005.3 0M5.5 12v8h13v-8M10 20v-4.5h4V20" />,
  chat: <path d="M5 5h14a1.5 1.5 0 011.5 1.5v8.5A1.5 1.5 0 0119 16.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 013.5 15V6.5A1.5 1.5 0 015 5z" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 017 0v3" />
    </>
  ),
  heart: <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0112 7.3 4.3 4.3 0 0119.5 10c0 5.4-7.5 10-7.5 10z" />,
  sparkle: <path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z" />,
  memory: (
    <>
      <path d="M12 4.5c-4 0-7 1.3-7 3v9c0 1.7 3 3 7 3s7-1.3 7-3v-9c0-1.7-3-3-7-3z" />
      <path d="M5 7.5c0 1.7 3 3 7 3s7-1.3 7-3M5 12c0 1.7 3 3 7 3s7-1.3 7-3" />
    </>
  ),
  rules: <path d="M7 4.5h10a1.5 1.5 0 011.5 1.5v13.5l-6.5-3.5-6.5 3.5V6A1.5 1.5 0 017 4.5z" />,
  refresh: <path d="M19 12a7 7 0 11-2-4.9M19 4.5v4h-4" />,
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </>
  ),
  question: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.5a2.5 2.5 0 014.8.9c0 1.7-2.4 2-2.4 3.6M12 16.8v.2" />
    </>
  ),
  stop: <path d="M8.5 3.5h7l5 5v7l-5 5h-7l-5-5v-7z" />,
};

export function Icon({ name, size = 22, stroke = 2, className }: { name: IconName; size?: number; stroke?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function SimTag({ long = false }: { long?: boolean }) {
  return (
    <span className="sim-tag" title="Simulated: not a real Visa authorization">
      {long ? "SIMULATED · not a real Visa authorization" : "SIMULATED"}
    </span>
  );
}

const STATUS_TEXT: Record<TxnStatus, string> = { approved: "Normal", paused: "Paused", blocked: "Blocked", released: "Okayed by Rosa" };
export function StatusChip({ status, big }: { status: TxnStatus; big?: boolean }) {
  return (
    <span className={`chip chip-${status}${big ? " chip-big" : ""}`}>
      <Icon name={status === "approved" || status === "released" ? "check" : status === "paused" ? "pause" : "stop"} size={big ? 18 : 14} stroke={2.4} />
      {STATUS_TEXT[status]}
    </span>
  );
}

const ACTOR: Record<TimelineEvent["actor"], { label: string; icon: IconName }> = {
  card: { label: "Card", icon: "card" },
  rules: { label: "Agreed rules", icon: "rules" },
  helper: { label: "Helper", icon: "shield" },
  rosa: { label: "Rosa", icon: "user" },
  priya: { label: "Priya", icon: "heart" },
  memory: { label: "Memory", icon: "memory" },
};

export function Timeline({ events, limit = 30, compact }: { events: TimelineEvent[]; limit?: number; compact?: boolean }) {
  const list = [...events].slice(0, limit).reverse();
  if (!list.length) return <p className="muted">Nothing yet today.</p>;
  return (
    <ol className={`timeline${compact ? " timeline-compact" : ""}`}>
      {list.map((e) => (
        <li key={e.id} className={`tl tl-${e.actor}`}>
          <span className="tl-dot">
            <Icon name={ACTOR[e.actor].icon} size={compact ? 13 : 15} />
          </span>
          <div className="tl-body">
            <div className="tl-meta">
              <strong>{ACTOR[e.actor].label}</strong> · {fmtTime(e.at)}
            </div>
            <div className="tl-text">{e.text.replace(/ RECALL: .*$/, "")}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function Toast({ message, onClose }: { message?: string; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => close.current(), 6000);
    return () => clearTimeout(t);
  }, [message]);
  if (!message) return null;
  return (
    <div className="toast" role="alert" onClick={onClose}>
      <Icon name="alert" size={18} />
      <span>{message}</span>
    </div>
  );
}

export function ConnectionBanner({ connected, error, hasState }: { connected: boolean; error?: string; hasState: boolean }) {
  if (connected) return null;
  if (!hasState) return null;
  return <div className="conn-banner">{error ?? "Reconnecting…"}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      <span>{label}</span>
    </div>
  );
}

export const THRESHOLD_CHOICES = [100, 150, 200, 250, 300, 400, 500];

/** Shared editor for the few rules a family can change. Values only; saving is up to the caller. */
export function RuleEditor({
  threshold,
  unusualStore,
  scamSafety,
  canEditScam,
  onChange,
  compact,
}: {
  threshold: number;
  unusualStore: boolean;
  scamSafety: boolean;
  canEditScam: boolean;
  onChange: (e: { thresholdUsd?: number; unusualStoreCheck?: boolean; scamSafety?: boolean }) => void;
  compact?: boolean;
}) {
  return (
    <div className={`rule-editor${compact ? " compact" : ""}`}>
      <div className="re-row">
        <div className="re-label">Check in on any purchase over</div>
        <div className="re-chips" role="radiogroup" aria-label="Check-in amount">
          {THRESHOLD_CHOICES.map((t) => (
            <button key={t} role="radio" aria-checked={t === threshold} className={`re-chip${t === threshold ? " on" : ""}`} onClick={() => onChange({ thresholdUsd: t })}>
              ${t}
            </button>
          ))}
        </div>
      </div>
      <label className="re-row re-toggle">
        <span className="re-label">Check in when a store charge is far above usual</span>
        <input type="checkbox" checked={unusualStore} onChange={(e) => onChange({ unusualStoreCheck: e.target.checked })} />
      </label>
      <label className={`re-row re-toggle${canEditScam ? "" : " disabled"}`}>
        <span className="re-label">
          Scam-safety rule: if a check-in sounds like a scam, keep the payment stopped
          {!canEditScam && <em> (Rosa's choice)</em>}
        </span>
        <input type="checkbox" checked={scamSafety} disabled={!canEditScam} onChange={(e) => onChange({ scamSafety: e.target.checked })} />
      </label>
    </div>
  );
}
