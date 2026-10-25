import { useEffect, useRef, useState } from "react";
import type { AppState, CheckIn } from "../../shared/types";
import { fmtMoney, fmtTime, useApi } from "../state";
import { usePushToTalk, useSpeaking } from "../voice";
import { Icon, SimTag, StatusChip } from "../ui";

interface Props {
  state: AppState;
  ci: CheckIn;
  onError: (m: string) => void;
  onDone: () => void;
  onWhy: () => void;
  whyText?: string;
  onReplay: (t: string) => void;
}

export function RosaCheckIn({ state, ci, onError, onDone, onWhy, whyText, onReplay }: Props) {
  const api = useApi();
  const txn = state.transactions.find((t) => t.id === ci.txnId)!;
  const waiting = state.checkIns.filter((c) => c.phase !== "resolved" && c.id !== ci.id).length;
  const [typed, setTyped] = useState("");
  const [showType, setShowType] = useState(false);
  const [sending, setSending] = useState(false);
  const speaking = useSpeaking();
  const helperLines = ci.transcript.filter((l) => l.speaker === "helper");
  const latest = helperLines[helperLines.length - 1];
  const scrollRef = useRef<HTMLOListElement>(null);

  const send = async (text: string, via: "voice" | "typed" | "quick_reply") => {
    if (!text.trim()) {
      onError("Please say or type an answer.");
      return;
    }
    setSending(true);
    try {
      await api("/checkin/answer", { text, via, checkInId: ci.id }, 30000);
      setTyped("");
      setShowType(false);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const confirm = async () => {
    setSending(true);
    try {
      const r = await api<{ ok: boolean; reason: string }>("/checkin/confirm", { checkInId: ci.id });
      if (!r.ok) onError(r.reason);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const ptt = usePushToTalk({
    cartesia: state.integrations.cartesiaStt.mode === "live",
    onText: (t) => void send(t, "voice"),
    onError,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [ci.transcript.length]);

  const alert = ci.outcome === "blocked_scam" || ci.outcome === "paused_concern";
  const released = ci.outcome === "released_by_rosa";
  const thinking = ci.phase === "thinking" || sending;
  const canAnswer = (ci.phase === "asking" || ci.phase === "awaiting_confirmation") && !!ci.question;

  return (
    <div className="checkin">
      <div className={`pay-strip pay-${txn.status}`}>
        <StatusChip status={txn.status} big />
        <span className="pay-what">
          <strong>{fmtMoney(txn.amount)}</strong> at {txn.merchant} · {txn.channel === "in_store" ? "in store" : "online"} · {fmtTime(txn.time)}
        </span>
        <SimTag long />
      </div>
      {waiting > 0 && <p className="queue-note">{waiting} more payment{waiting > 1 ? "s" : ""} waiting for a quick check after this one.</p>}

      <div className="checkin-grid">
        <div className="checkin-main">
          {alert ? (
            <div className="outcome outcome-alert fade-up" aria-live="assertive">
              <div className="outcome-badge">
                <Icon name="phone" size={34} />
                <span className="slash" />
              </div>
              <h1 className="outcome-title">Please hang up the phone.</h1>
              <p className="outcome-sub">That call is a scam. Don't buy anything.</p>
              <ul className="outcome-checks">
                <li>
                  <Icon name="check" size={22} stroke={2.6} /> The {fmtMoney(txn.amount)} payment {ci.outcome === "blocked_scam" ? "did not go through" : "is on hold"}
                </li>
                <li>
                  <Icon name="check" size={22} stroke={2.6} /> Priya knows{ci.familyNotifiedAt ? ` (told at ${fmtTime(ci.familyNotifiedAt)})` : ""}, and may call you
                </li>
                <li>
                  <Icon name="check" size={22} stroke={2.6} /> I'll remember this call for next time
                </li>
              </ul>
              {whyText ? <WhyPanel text={whyText} /> : latest && <Caption text={latest.text} speaking={speaking} onReplay={() => onReplay(latest.text)} small />}
              <div className="outcome-actions">
                <button className="btn btn-ghost btn-lg" onClick={onWhy}>
                  <Icon name="question" size={22} /> Why was this paused?
                </button>
                <button className="btn btn-dark btn-lg" onClick={onDone}>
                  {waiting ? "I'm okay. Next" : "I'm okay. Back to home"}
                </button>
              </div>
            </div>
          ) : released ? (
            <div className="outcome outcome-ok fade-up" aria-live="polite">
              <div className="outcome-badge ok">
                <Icon name="check" size={38} stroke={2.6} />
              </div>
              <h1 className="outcome-title">All set, Rosa.</h1>
              <p className="outcome-sub">You can use your card again at {txn.merchant.replace(/ Pharmacy$/, "")}. Priya just gets a quick note.</p>
              {latest && <Caption text={latest.text} speaking={speaking} onReplay={() => onReplay(latest.text)} small />}
              <div className="outcome-actions">
                <button className="btn btn-dark btn-lg" onClick={onDone}>
                  Back to home
                </button>
              </div>
            </div>
          ) : (
            <>
              {!ci.question ? (
                <div className="preparing">
                  <span className="spinner" /> One moment, Rosa…
                </div>
              ) : (
                <Caption text={latest?.text ?? ci.question} speaking={speaking} onReplay={() => onReplay(latest?.text ?? ci.question)} />
              )}

              {thinking ? (
                <Working steps={ci.working} sending={sending && ci.phase !== "thinking"} />
              ) : canAnswer ? (
                <div className="answer fade-up">
                  {ptt.mode !== "none" && (
                    <div className="ptt-wrap">
                      <button
                        className={`ptt${ptt.listening ? " listening" : ""}${ptt.transcribing ? " busy" : ""}`}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          void ptt.start();
                        }}
                        onPointerUp={() => ptt.stop()}
                        onPointerLeave={() => ptt.listening && ptt.stop()}
                        onKeyDown={(e) => {
                          if ((e.key === " " || e.key === "Enter") && !e.repeat) void ptt.start();
                        }}
                        onKeyUp={(e) => {
                          if (e.key === " " || e.key === "Enter") ptt.stop();
                        }}
                        disabled={ptt.transcribing}
                        aria-label="Hold to talk"
                      >
                        <span className="ptt-rings" />
                        <Icon name="mic" size={40} stroke={2.2} />
                      </button>
                      <div className="ptt-label">
                        {ptt.transcribing ? "Writing down what you said…" : ptt.listening ? "I'm listening. Let go when you're done." : "Hold to talk"}
                        {ptt.interim && <div className="ptt-interim">“{ptt.interim}”</div>}
                      </div>
                    </div>
                  )}

                  <div className="quick">
                    {ci.phase === "awaiting_confirmation" ? (
                      <>
                        <button className="btn btn-confirm btn-xl" onClick={confirm}>
                          <Icon name="check" size={26} stroke={2.6} /> Yes, this was me
                        </button>
                        <button className="btn btn-outline btn-xl" onClick={() => send("Actually, someone is on the phone asking me to buy this.", "quick_reply")}>
                          <Icon name="phone" size={24} /> Someone is on the phone
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-outline btn-xl" onClick={() => send("Yes, someone is on the phone asking me to buy something.", "quick_reply")}>
                          <Icon name="phone" size={24} /> Yes, someone is on the phone
                        </button>
                        <button className="btn btn-outline btn-xl" onClick={() => send("No, this was me.", "quick_reply")}>
                          <Icon name="user" size={24} /> No, this was me
                        </button>
                      </>
                    )}
                  </div>

                  {showType ? (
                    <form
                      className="type-row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send(typed, "typed");
                      }}
                    >
                      <input
                        autoFocus
                        className="type-input"
                        value={typed}
                        maxLength={500}
                        onChange={(e) => setTyped(e.target.value)}
                        placeholder="Type your answer…"
                        aria-label="Type your answer"
                      />
                      <button className="btn btn-primary btn-lg" type="submit" disabled={!typed.trim()}>
                        Send
                      </button>
                    </form>
                  ) : (
                    <button className="link-btn" onClick={() => setShowType(true)}>
                      <Icon name="keyboard" size={20} /> Type my answer instead
                    </button>
                  )}
                </div>
              ) : null}

              <button className="why-btn" onClick={onWhy}>
                <Icon name="question" size={20} /> Why was this paused?
              </button>
            </>
          )}
          {whyText && !alert && <WhyPanel text={whyText} />}
        </div>

        <aside className="checkin-side">
          <h2 className="side-title">What we said</h2>
          <ol className="convo" ref={scrollRef}>
            {ci.transcript.map((l) => (
              <li key={l.id} className={`bubble bubble-${l.speaker}`}>
                <span className="bubble-who">
                  {l.speaker === "helper" ? "Helper" : "You"}
                  {l.speaker === "rosa" && l.via && <em> · {l.via === "voice" ? "spoken" : l.via === "typed" ? "typed" : "tapped"}</em>}
                </span>
                {l.text}
              </li>
            ))}
            {ci.transcript.length === 0 && <li className="muted">Getting ready…</li>}
          </ol>
        </aside>
      </div>
    </div>
  );
}

function Caption({ text, speaking, onReplay, small }: { text: string; speaking: boolean; onReplay: () => void; small?: boolean }) {
  return (
    <div className={`caption${small ? " caption-small" : ""} fade-up`} aria-live="polite">
      <div className="caption-head">
        <span className={`voice-bars${speaking ? " on" : ""}`} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>{speaking ? "Speaking…" : "Your helper"}</span>
        <button className="replay" onClick={onReplay}>
          <Icon name="speaker" size={18} /> Hear again
        </button>
      </div>
      <p className="caption-text">{text}</p>
    </div>
  );
}

function WhyPanel({ text }: { text: string }) {
  return (
    <div className="why-panel fade-up" aria-live="polite">
      <Icon name="rules" size={20} />
      <p>{text}</p>
    </div>
  );
}

function Working({ steps, sending }: { steps: CheckIn["working"]; sending: boolean }) {
  const list = steps.length && !sending ? steps : [{ step: "Understanding what you said", done: false }];
  const firstOpen = list.findIndex((s) => !s.done);
  return (
    <ol className="working fade-up" aria-live="polite">
      {list.map((s, i) => (
        <li key={s.step} className={s.done ? "done" : i === firstOpen ? "active" : "todo"}>
          <span className="w-dot">{s.done ? <Icon name="check" size={16} stroke={3} /> : i === firstOpen ? <span className="spinner sm" /> : null}</span>
          {s.step}
        </li>
      ))}
    </ol>
  );
}
