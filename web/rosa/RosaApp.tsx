import { useEffect, useRef, useState } from "react";
import { useAppState, useApi, fmtTime } from "../state";
import { speak, stopSpeaking, useSpeaking } from "../voice";
import { ConnectionBanner, Icon, Loading, Toast } from "../ui";
import { RosaSetup } from "./RosaSetup";
import { RosaHome } from "./RosaHome";
import { RosaCheckIn } from "./RosaCheckIn";
import { RosaRules } from "./RosaRules";
import { RosaHistory } from "./RosaHistory";

type Tab = "home" | "rules" | "history";

export function RosaApp() {
  const { state, connected, error } = useAppState();
  const api = useApi();
  const [toast, setToast] = useState<string>();
  const [tab, setTab] = useState<Tab>("home");
  const [voiceOn, setVoiceOn] = useState(() => !new URLSearchParams(location.search).has("mute") && localStorage.getItem("gc-voice") !== "off");
  const [needsTap, setNeedsTap] = useState<string>();
  const [whyText, setWhyText] = useState<string>();
  const spoken = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const speaking = useSpeaking();

  const cartesia = state?.integrations.cartesiaTts.mode === "live";

  const say = async (text: string) => {
    if (!voiceOn) return;
    const r = await speak(text, { cartesia });
    setNeedsTap(r === "blocked" ? text : undefined);
  };

  // Speak each new helper line once, as soon as it arrives (not on page reload).
  useEffect(() => {
    if (!state) return;
    const ci = state.checkIns.find((c) => c.id === state.activeCheckInId);
    const lines = ci?.transcript.filter((l) => l.speaker === "helper") ?? [];
    if (!primed.current) {
      const cutoff = Date.now() - 15000;
      state.checkIns.forEach((c) => c.transcript.forEach((l) => new Date(l.at).getTime() < cutoff && spoken.current.add(l.id)));
      if (state.rosaNotice && new Date(state.rosaNotice.at).getTime() < cutoff) spoken.current.add(state.rosaNotice.id);
      primed.current = true;
    }
    const fresh = lines.filter((l) => !spoken.current.has(l.id));
    if (fresh.length) {
      lines.forEach((l) => spoken.current.add(l.id));
      void say(fresh[fresh.length - 1].text);
    } else if (state.rosaNotice && !spoken.current.has(state.rosaNotice.id)) {
      spoken.current.add(state.rosaNotice.id);
      void say(state.rosaNotice.spoken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.version]);

  useEffect(() => setWhyText(undefined), [state?.activeCheckInId]);

  if (!state) {
    return (
      <div className="rosa">
        <div className="rosa-center">{error ? <p className="big-muted">{error}</p> : <Loading label="Starting Rosa's helper…" />}</div>
      </div>
    );
  }

  const ci = state.checkIns.find((c) => c.id === state.activeCheckInId);
  const agreed = Boolean(state.agreement.rosaSignedAt && state.agreement.priyaSignedAt);
  const pendingFromPriya = state.ruleChanges.find((c) => c.status === "pending" && c.proposedBy === "priya");
  const unread = state.messages.filter((m) => m.from === "priya" && !m.readAt);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      setToast((e as Error).message);
    }
  };
  const askWhy = (txnId?: string) =>
    run(async () => {
      const r = await api<{ text: string }>("/why", { txnId });
      setWhyText(r.text);
      void say(r.text);
      return r;
    });

  const mode = ci ? (ci.outcome === "blocked_scam" || ci.outcome === "paused_concern" ? "alert" : ci.outcome === "released_by_rosa" ? "ok" : "checkin") : "";
  const view = !agreed ? "setup" : ci ? `ci-${ci.id}` : tab;

  return (
    <div className={`rosa${mode ? ` rosa-mode-${mode}` : ""}`}>
      <header className="rosa-header">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="shield" size={20} stroke={2.2} />
          </span>
          <span className="brand-name">GuardianCart</span>
          <span className="brand-sub">Rosa's helper</span>
        </div>
        <div className="rosa-header-right">
          {state.callMom?.status === "calling" && (
            <span className="incoming-call">
              <Icon name="phone" size={16} /> Priya is calling you <em>(simulated)</em>
            </span>
          )}
          <button
            className={`voice-toggle${voiceOn ? " on" : ""}${speaking ? " speaking" : ""}`}
            onClick={() => {
              const v = !voiceOn;
              setVoiceOn(v);
              localStorage.setItem("gc-voice", v ? "on" : "off");
              if (!v) stopSpeaking();
            }}
            aria-pressed={voiceOn}
          >
            <Icon name="speaker" size={18} />
            {voiceOn ? "Voice on" : "Voice off"}
          </button>
        </div>
      </header>
      {agreed && !ci && (
        <nav className="rosa-tabs" aria-label="Sections">
          {(
            [
              ["home", "Home", "heart"],
              ["rules", "My rules", "rules"],
              ["history", "Past check-ins", "shield"],
            ] as const
          ).map(([k, label, icon]) => (
            <button key={k} className={`rosa-tab${tab === k ? " on" : ""}`} aria-current={tab === k} onClick={() => setTab(k)}>
              <Icon name={icon} size={22} /> {label}
              {k === "rules" && pendingFromPriya && <span className="badge">1</span>}
            </button>
          ))}
        </nav>
      )}

      <ConnectionBanner connected={connected} error={error} hasState />
      {needsTap && (
        <button className="tap-to-hear" onClick={() => void say(needsTap)}>
          <Icon name="speaker" size={20} /> Tap to hear your helper
        </button>
      )}

      <main className="rosa-main" key={view}>
        {agreed && !ci && unread.length > 0 && (
          <div className="msg-banner fade-up" role="status">
            <span className="avatar sm">P</span>
            <div className="msg-body">
              <div className="msg-from">Message from Priya · {fmtTime(unread[0].at)}</div>
              <div className="msg-text">{unread[0].text}</div>
            </div>
            <div className="msg-actions">
              <button className="btn btn-outline btn-lg" onClick={() => run(async () => { await api("/messages", { from: "rosa", text: "I'm okay." }); await api(`/messages/${unread[0].id}/read`); })}>
                I'm okay
              </button>
              <button className="btn btn-primary btn-lg" onClick={() => run(async () => { await api("/messages", { from: "rosa", text: "Please call me." }); await api(`/messages/${unread[0].id}/read`); })}>
                Please call me
              </button>
            </div>
          </div>
        )}
        {agreed && !ci && pendingFromPriya && tab !== "rules" && (
          <button className="proposal-banner fade-up" onClick={() => setTab("rules")}>
            <Icon name="rules" size={22} /> Priya suggested a change to your rules. <strong>Take a look</strong>
          </button>
        )}

        {!agreed ? (
          <RosaSetup state={state} onError={setToast} />
        ) : ci ? (
          <RosaCheckIn
            key={ci.id}
            state={state}
            ci={ci}
            onError={setToast}
            onDone={() =>
              run(async () => {
                stopSpeaking();
                await api("/checkin/dismiss", { checkInId: ci.id });
                setTab("home");
              })
            }
            onWhy={() => askWhy()}
            whyText={whyText}
            onReplay={(t) => void say(t)}
          />
        ) : tab === "rules" ? (
          <RosaRules state={state} onError={setToast} />
        ) : tab === "history" ? (
          <RosaHistory state={state} />
        ) : (
          <RosaHome state={state} onWhy={askWhy} whyText={whyText} onCloseWhy={() => setWhyText(undefined)} />
        )}
      </main>
      <Toast message={toast} onClose={() => setToast(undefined)} />
    </div>
  );
}
