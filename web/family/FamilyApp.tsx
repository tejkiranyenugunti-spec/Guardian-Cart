import { useState } from "react";
import type { AppState, CheckIn, FamilyAlert, RuleEdit } from "../../shared/types";
import { fmtDate, fmtDay, fmtMoney, fmtTime, useApi, useAppState } from "../state";
import { ConnectionBanner, Icon, Loading, RuleEditor, SimTag, StatusChip, THRESHOLD_CHOICES, Timeline, Toast } from "../ui";

type Tab = "mom" | "rules" | "history";
type Run = (f: () => Promise<unknown>) => Promise<void>;

/** Rules and headlines are written in Rosa's voice; show them from Priya's side. */
export function forPriya(t: string) {
  return t
    .replace(/Check in with me/g, "Check in with Mom")
    .replace(/\bmy usual\b/g, "her usual")
    .replace(/and tell Priya/g, "and tell you")
    .replace(/Rosa was told/g, "Mom was told")
    .replace(/Priya notified\./g, "You were notified.")
    .replace(/^Rosa confirmed/, "Mom confirmed");
}

export function FamilyApp() {
  const { state, connected, error } = useAppState();
  const api = useApi();
  const [toast, setToast] = useState<string>();
  const [tab, setTab] = useState<Tab>("mom");
  const [openIncident, setOpenIncident] = useState<string>();
  const [composing, setComposing] = useState(false);

  if (!state) return <div className="fam fam-center">{error ? <p>{error}</p> : <Loading label="Connecting…" />}</div>;

  const agreed = Boolean(state.agreement.rosaSignedAt && state.agreement.priyaSignedAt);
  const urgent = state.alerts.find((a) => a.level === "urgent" && !a.acknowledged);
  const pendingFromMom = state.ruleChanges.find((c) => c.status === "pending" && c.proposedBy === "rosa");
  const run: Run = async (fn) => {
    try {
      await fn();
    } catch (e) {
      setToast((e as Error).message);
    }
  };
  const incident = openIncident ? state.checkIns.find((c) => c.id === openIncident) : undefined;
  const view = !agreed ? "setup" : urgent ? urgent.id : incident ? `inc-${incident.id}` : tab;

  return (
    <div className={`fam${urgent && agreed ? " fam-urgent" : ""}`}>
      <header className="fam-header">
        <div className="fam-who">
          <span className="avatar">R</span>
          <div>
            <div className="fam-name">Mom · Rosa</div>
            <div className="fam-role">You're her trusted contact</div>
          </div>
        </div>
        <span className="brand-mark sm" title="GuardianCart">
          <Icon name="shield" size={16} stroke={2.2} />
        </span>
      </header>
      <ConnectionBanner connected={connected} error={error} hasState />

      <main className="fam-main" key={view}>
        {!agreed ? (
          <FamilySetup state={state} run={run} />
        ) : urgent ? (
          <UrgentView state={state} alert={urgent} run={run} onMessage={() => setComposing(true)} />
        ) : incident ? (
          <div className="fade-up">
            <button className="back-btn" onClick={() => setOpenIncident(undefined)}>
              ← Back
            </button>
            <IncidentDetail state={state} ci={incident} />
          </div>
        ) : tab === "rules" ? (
          <FamilyRules state={state} run={run} />
        ) : tab === "history" ? (
          <FamilyHistory state={state} onOpen={setOpenIncident} />
        ) : (
          <CalmView state={state} run={run} onMessage={() => setComposing(true)} onOpen={setOpenIncident} />
        )}
      </main>

      {agreed && !urgent && (
        <nav className="fam-tabs" aria-label="Sections">
          {(
            [
              ["mom", "Mom", "heart"],
              ["rules", "Rules", "rules"],
              ["history", "History", "shield"],
            ] as const
          ).map(([k, label, icon]) => (
            <button
              key={k}
              className={`fam-tab${tab === k && !incident ? " on" : ""}`}
              aria-current={tab === k}
              onClick={() => {
                setOpenIncident(undefined);
                setTab(k);
              }}
            >
              <Icon name={icon} size={20} />
              {label}
              {k === "rules" && pendingFromMom && <span className="badge">1</span>}
            </button>
          ))}
        </nav>
      )}

      {composing && <Composer onClose={() => setComposing(false)} onSend={(text) => run(async () => { await api("/messages", { from: "priya", text }); setComposing(false); setToast("Sent to Mom's tablet."); })} />}

      {state.callMom?.status === "calling" && (
        <div className="call-overlay fade-in" role="dialog" aria-label="Calling Mom">
          <div className="call-avatar">R</div>
          <div className="call-name">Calling Mom…</div>
          <div className="call-sim">Simulated call. No real phone call is made yet.</div>
          <button className="call-end" onClick={() => run(() => api("/call-mom", { action: "end" }))} aria-label="End call">
            <Icon name="phone" size={28} />
          </button>
        </div>
      )}
      <Toast message={toast} onClose={() => setToast(undefined)} />
    </div>
  );
}

function ContactRow({ run, onMessage, light }: { run: Run; onMessage: () => void; light?: boolean }) {
  const api = useApi();
  return (
    <div className={`contact-row${light ? " light" : ""}`}>
      <button className="call-btn" onClick={() => run(() => api("/call-mom", { action: "start" }))}>
        <Icon name="phone" size={22} /> Call Mom
      </button>
      <button className="msg-btn" onClick={onMessage}>
        <Icon name="chat" size={20} /> Message
      </button>
    </div>
  );
}

function Composer({ onClose, onSend }: { onClose: () => void; onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  const quick = ["I'm calling you now.", "Please don't buy anything. I'll call you.", "Are you okay, Mom?"];
  return (
    <div className="sheet-backdrop fade-in" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Message Mom" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">Message to Mom's tablet</div>
        <div className="quick-msgs">
          {quick.map((q) => (
            <button key={q} className="quick-msg" onClick={() => onSend(q)}>
              {q}
            </button>
          ))}
        </div>
        <form
          className="sheet-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onSend(text);
          }}
        >
          <input className="sheet-input" value={text} maxLength={280} onChange={(e) => setText(e.target.value)} placeholder="Write your own…" aria-label="Message" />
          <button className="btn btn-primary" type="submit" disabled={!text.trim()}>
            Send
          </button>
        </form>
        <button className="link-btn small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function FamilySetup({ state, run }: { state: AppState; run: Run }) {
  const api = useApi();
  const a = state.agreement;
  const big = state.rules.find((r) => r.kind === "single_purchase_checkin")!;
  const edit = (e: RuleEdit) => run(() => api("/rules/edit", { who: "priya", edit: e }));
  return (
    <div className="fam-setup fade-up">
      <p className="eyebrow">Set up with Mom</p>
      <h1 className="fam-h1">Safety rules for Mom's card</h1>
      <p className="fam-lead">You suggest, Mom decides. You'll only hear from GuardianCart when something is unusual. No approvals for everyday shopping.</p>
      <ol className="fam-rules">
        {state.rules.map((r) => {
          const isScam = r.kind === "scam_safety_block";
          return (
            <li key={r.id} className={r.enabled ? "" : "off"}>
              <Icon name={r.action === "check_in" ? "chat" : "lock"} size={18} />
              <div>
                <div className="fr-title">{forPriya(r.title)}</div>
                <div className="fr-vtc">{r.vtcConcept}</div>
                {r.kind === "single_purchase_checkin" && !a.priyaSignedAt && (
                  <div className="re-chips small" role="radiogroup" aria-label="Check-in amount">
                    {THRESHOLD_CHOICES.map((t) => (
                      <button key={t} role="radio" aria-checked={t === big.params.thresholdUsd} className={`re-chip${t === big.params.thresholdUsd ? " on" : ""}`} onClick={() => edit({ thresholdUsd: t })}>
                        ${t}
                      </button>
                    ))}
                  </div>
                )}
                {isScam && <div className={`fr-choice${a.scamSafetyOptIn ? " on" : ""}`}>{a.scamSafetyOptIn ? "Mom turned this on" : a.rosaSignedAt ? "Mom left this off" : "Mom's choice: waiting for her"}</div>}
                {r.kind === "merchant_anomaly_checkin" && !r.enabled && <div className="fr-choice">Turned off</div>}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="fam-sign">
        <div className={`sign-line${a.rosaSignedAt ? " signed" : ""}`}>
          <span className="sign-check">{a.rosaSignedAt && <Icon name="check" size={14} stroke={3} />}</span>
          Mom {a.rosaSignedAt ? `agreed at ${fmtTime(a.rosaSignedAt)}` : "hasn't agreed yet"}
        </div>
        <div className={`sign-line${a.priyaSignedAt ? " signed" : ""}`}>
          <span className="sign-check">{a.priyaSignedAt && <Icon name="check" size={14} stroke={3} />}</span>
          You {a.priyaSignedAt ? `agreed at ${fmtTime(a.priyaSignedAt)}` : "haven't agreed yet"}
        </div>
        {!a.priyaSignedAt && (
          <button className="btn btn-primary btn-block" onClick={() => run(() => api("/setup/sign", { who: "priya" }))}>
            I agree to these rules
          </button>
        )}
      </div>
    </div>
  );
}

function UrgentView({ state, alert, run, onMessage }: { state: AppState; alert: FamilyAlert; run: Run; onMessage: () => void }) {
  const api = useApi();
  const ci = state.checkIns.find((c) => c.id === alert.checkInId);
  const txn = state.transactions.find((t) => t.id === alert.txnId);
  const rules = state.rules.filter((r) => txn?.firedRuleIds.includes(r.id));
  return (
    <div className="urgent fade-in">
      <section className="urgent-hero">
        <div className="urgent-kicker">
          <Icon name="alert" size={16} stroke={2.4} /> Urgent · {fmtTime(alert.at)}
        </div>
        <h1 className="urgent-title">{alert.title}</h1>
        <p className="urgent-body">{alert.body}</p>
        <ContactRow run={run} onMessage={onMessage} light />
        <div className="urgent-sim">Calls are simulated for now. Messages appear on Mom's tablet.</div>
      </section>

      {ci && <IncidentDetail state={state} ci={ci} />}
      {!ci && txn && (
        <section className="fam-card">
          <h2 className="fam-h2">From the card</h2>
          <CardFacts
            facts={[
              { label: "Store", value: txn.merchant },
              { label: "Category", value: `${txn.category} (MCC ${txn.mcc})` },
              { label: "Amount", value: fmtMoney(txn.amount) },
              { label: "Where", value: txn.channel === "in_store" ? "In store" : "Online" },
            ]}
          />
          <div className="rule-fired">
            <Icon name="rules" size={16} /> {rules.map((r) => forPriya(r.title)).join(" + ")}
          </div>
        </section>
      )}

      <button className="btn btn-ghost-light btn-block" onClick={() => run(() => api(`/alerts/${alert.id}/ack`))}>
        Mark as handled
      </button>
    </div>
  );
}

export function IncidentDetail({ state, ci }: { state: AppState; ci: CheckIn }) {
  const txn = state.transactions.find((t) => t.id === ci.txnId);
  if (!txn) return null;
  const rules = state.rules.filter((r) => txn.firedRuleIds.includes(r.id));
  const rosaLines = ci.transcript.filter((l) => l.speaker === "rosa");
  return (
    <>
      <section className="fam-card outcome-card">
        <div className="oc-row">
          <StatusChip status={txn.status} />
          <SimTag />
        </div>
        <p className="oc-headline">{ci.outcomeHeadline ? forPriya(ci.outcomeHeadline) : `${fmtMoney(txn.amount)} at ${txn.merchant}: checking in with Mom`}</p>
        {ci.familySummary && <p className="oc-summary">{ci.familySummary}</p>}
      </section>

      <section className="fam-card split-card">
        <div className="split-col">
          <h2 className="fam-h2">
            <Icon name="card" size={16} /> From the card
          </h2>
          <CardFacts facts={ci.cardFacts.filter((f) => f.label !== "Rule")} />
          <p className="split-note">All the card can know. It can't see what's in the basket.</p>
        </div>
        <div className="split-col from-rosa">
          <h2 className="fam-h2">
            <Icon name="user" size={16} /> From Mom
          </h2>
          {rosaLines.length === 0 && <p className="muted">She hasn't answered yet.</p>}
          {rosaLines.map((l) => (
            <blockquote key={l.id} className="quote">
              “{l.text}”
            </blockquote>
          ))}
          {ci.rosaFacts.length > 0 && (
            <ul className="rosa-facts">
              {ci.rosaFacts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {(ci.aiReason || (ci.indicators && ci.indicators.length > 0)) && (
        <section className="fam-card">
          <h2 className="fam-h2">
            <Icon name="sparkle" size={16} /> Why the helper was concerned
          </h2>
          {ci.aiReason && <p className="oc-summary">{ci.aiReason}</p>}
          {ci.indicators && ci.indicators.length > 0 && (
            <ul className="indicators">
              {ci.indicators.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
          <p className="split-note">Based only on what Mom said{ci.riskSource === "claude+rules" ? " (AI analysis + scam-phrase rules)" : " (scam-phrase rules)"}.</p>
        </section>
      )}

      <section className="fam-card">
        <h2 className="fam-h2">
          <Icon name="rules" size={16} /> Rules that applied
        </h2>
        <ul className="applied-rules">
          {rules.map((r) => (
            <li key={r.id}>
              <span className={`tag tag-${r.action}`}>{r.action === "check_in" ? "Check-in" : "Keep stopped"}</span>
              {forPriya(r.title)}
            </li>
          ))}
        </ul>
        <p className="split-note">Decided by fixed rules you and Mom agreed on. The AI only reports what Mom said; it can't block or release payments.</p>
      </section>

      <section className="fam-card">
        <h2 className="fam-h2">
          <Icon name="chat" size={16} /> Conversation
        </h2>
        <ol className="fam-convo">
          {ci.transcript.map((l) => (
            <li key={l.id} className={`fc fc-${l.speaker}`}>
              <span className="fc-who">
                {l.speaker === "helper" ? "Helper" : "Mom"} · {fmtTime(l.at)}
              </span>
              {l.text}
            </li>
          ))}
        </ol>
      </section>

      <section className="fam-card">
        <h2 className="fam-h2">Timeline</h2>
        <Timeline events={state.timeline.filter((e) => e.checkInId === ci.id)} limit={20} compact />
      </section>
    </>
  );
}

function CardFacts({ facts }: { facts: { label: string; value: string }[] }) {
  return (
    <dl className="facts">
      {facts.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CalmView({ state, run, onMessage, onOpen }: { state: AppState; run: Run; onMessage: () => void; onOpen: (id: string) => void }) {
  const active = state.checkIns.find((c) => c.phase !== "resolved");
  const activeTxn = active && state.transactions.find((t) => t.id === active.txnId);
  const today = new Date().toDateString();
  const normalToday = state.transactions.filter((t) => t.status === "approved" && new Date(t.time).toDateString() === today).length;
  const lastResolved = state.checkIns.find((c) => c.phase === "resolved");
  const handledRecently = state.alerts.some((a) => a.level === "urgent" && a.acknowledged && Date.now() - new Date(a.at).getTime() < 24 * 3600 * 1000);
  const infos = state.alerts.filter((a) => a.level === "info" && !(active && a.checkInId === active.id)).slice(0, 3);
  const thread = state.messages.slice(0, 4);

  return (
    <div className="calm fade-up">
      {active && activeTxn ? (
        <section className="fam-card checking-card">
          <div className="checking-row">
            <span className="pulse-dot amber" />
            <span className="checking-label">Checking in with Mom now</span>
          </div>
          <p className="checking-text">
            {fmtMoney(activeTxn.amount)} at {activeTxn.merchant} was paused by a rule you both agreed on. Her helper is asking her about it.
          </p>
          <p className="checking-note">No action needed. You'll hear back only if something is wrong.</p>
        </section>
      ) : (
        <section className="calm-hero">
          <div className="calm-icon">
            <Icon name="heart" size={26} />
          </div>
          <h1 className="fam-h1">{handledRecently ? "Mom is safe" : "Mom is doing fine"}</h1>
          <p className="fam-lead">
            {normalToday ? `${normalToday} normal purchase${normalToday > 1 ? "s" : ""} today. ` : ""}Nothing needs you right now.
          </p>
        </section>
      )}
      <ContactRow run={run} onMessage={onMessage} />

      {thread.length > 0 && (
        <section className="fam-card">
          <h2 className="fam-h2">Messages</h2>
          <ul className="thread">
            {thread.map((m) => (
              <li key={m.id} className={`tm tm-${m.from}`}>
                <span className="tm-who">
                  {m.from === "rosa" ? "Mom" : "You"} · {fmtTime(m.at)}
                  {m.from === "priya" && (m.readAt ? " · seen" : " · delivered")}
                </span>
                {m.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {lastResolved && !active && (
        <button className="fam-card card-btn" onClick={() => onOpen(lastResolved.id)}>
          <h2 className="fam-h2">Latest check-in · {fmtDay(lastResolved.startedAt)}</h2>
          <p className="oc-headline">{forPriya(lastResolved.outcomeHeadline ?? "")}</p>
          <span className="card-more">See conversation →</span>
        </button>
      )}

      {infos.length > 0 && (
        <section className="fam-card">
          <h2 className="fam-h2">Notes</h2>
          <ul className="notes">
            {infos.map((a) => (
              <li key={a.id}>
                <span className="note-time">{fmtTime(a.at)}</span>
                <div>
                  <div className="note-title">{a.title}</div>
                  <div className="note-body">{a.body}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="fam-card">
        <h2 className="fam-h2">Unusual activity</h2>
        {state.transactions.filter((t) => t.status !== "approved").length === 0 ? (
          <p className="muted">None. Everyday purchases don't ping you.</p>
        ) : (
          <ul className="fam-txns">
            {state.transactions
              .filter((t) => t.status !== "approved")
              .slice(0, 6)
              .map((t) => (
                <li key={t.id}>
                  <div>
                    <div className="ft-merchant">{t.merchant}</div>
                    <div className="ft-sub">
                      {fmtDay(t.time)} {fmtTime(t.time)} · {fmtMoney(t.amount)}
                    </div>
                  </div>
                  <div className="ft-tags">
                    <StatusChip status={t.status} />
                    <SimTag />
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FamilyRules({ state, run }: { state: AppState; run: Run }) {
  const api = useApi();
  const big = state.rules.find((r) => r.kind === "single_purchase_checkin")!;
  const store = state.rules.find((r) => r.kind === "merchant_anomaly_checkin")!;
  const current = { thresholdUsd: big.params.thresholdUsd ?? 200, unusualStoreCheck: store.enabled, scamSafety: state.agreement.scamSafetyOptIn };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const pending = state.ruleChanges.find((c) => c.status === "pending");
  const past = state.ruleChanges.filter((c) => c.status !== "pending").slice(0, 5);
  const agreedAt = [state.agreement.rosaSignedAt, state.agreement.priyaSignedAt].sort()[1];
  const changed: RuleEdit = {};
  if (draft.thresholdUsd !== current.thresholdUsd) changed.thresholdUsd = draft.thresholdUsd;
  if (draft.unusualStoreCheck !== current.unusualStoreCheck) changed.unusualStoreCheck = draft.unusualStoreCheck;
  if (draft.scamSafety !== current.scamSafety) changed.scamSafety = draft.scamSafety;

  return (
    <div className="fade-up">
      <h1 className="fam-h1 sm">Rules you agreed on</h1>
      <p className="fam-lead">Changes need both of you. Mom sees your suggestion on her tablet and decides.</p>

      {pending && (
        <section className={`fam-card proposal-card ${pending.proposedBy}`}>
          <h2 className="fam-h2">{pending.proposedBy === "priya" ? "Your suggestion" : "Mom suggested a change"}</h2>
          <ul className="proposal-list small">
            {pending.summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {pending.proposedBy === "priya" ? (
            <>
              <p className="waiting small">
                <span className="pulse-dot amber" /> Waiting for Mom to agree
              </p>
              <button className="link-btn small" onClick={() => run(() => api("/rules/respond", { who: "priya", changeId: pending.id, accept: false }))}>
                Take back
              </button>
            </>
          ) : (
            <div className="row-btns">
              <button className="btn btn-primary" onClick={() => run(() => api("/rules/respond", { who: "priya", changeId: pending.id, accept: true }))}>
                Agree
              </button>
              <button className="btn btn-ghost-light" onClick={() => run(() => api("/rules/respond", { who: "priya", changeId: pending.id, accept: false }))}>
                Not now
              </button>
            </div>
          )}
        </section>
      )}

      <section className="fam-card">
        <ul className="mini-rules small">
          {state.rules
            .filter((r) => (r.kind !== "scam_safety_block" || state.agreement.scamSafetyOptIn) && r.enabled)
            .map((r) => (
              <li key={r.id}>
                <Icon name={r.action === "check_in" ? "chat" : "lock"} size={15} />
                <span>
                  {forPriya(r.title)}
                  <span className="fr-vtc block">{r.vtcConcept}</span>
                </span>
              </li>
            ))}
        </ul>
        {agreedAt && (
          <p className="agreed-by small">
            <Icon name="check" size={14} stroke={2.6} /> Agreed by Rosa and Priya · {fmtDate(agreedAt)}
          </p>
        )}
      </section>

      {!pending &&
        (editing ? (
          <section className="fam-card fade-up">
            <h2 className="fam-h2">Suggest a change</h2>
            <RuleEditor
              compact
              threshold={draft.thresholdUsd}
              unusualStore={draft.unusualStoreCheck}
              scamSafety={draft.scamSafety}
              canEditScam
              onChange={(e) => setDraft((d) => ({ thresholdUsd: e.thresholdUsd ?? d.thresholdUsd, unusualStoreCheck: e.unusualStoreCheck ?? d.unusualStoreCheck, scamSafety: e.scamSafety ?? d.scamSafety }))}
            />
            <div className="row-btns">
              <button
                className="btn btn-primary"
                disabled={Object.keys(changed).length === 0}
                onClick={() =>
                  run(async () => {
                    await api("/rules/edit", { who: "priya", edit: changed });
                    setEditing(false);
                  })
                }
              >
                Send to Mom
              </button>
              <button className="btn btn-ghost-light" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </section>
        ) : (
          <button
            className="btn btn-outline btn-block"
            onClick={() => {
              setDraft(current);
              setEditing(true);
            }}
          >
            Suggest a rule change
          </button>
        ))}

      {past.length > 0 && (
        <section className="fam-card">
          <h2 className="fam-h2">Earlier changes</h2>
          <ul className="past-changes small">
            {past.map((c) => (
              <li key={c.id}>
                <strong>{c.status === "agreed" ? "Mom and you agreed" : c.declinedBy === c.proposedBy ? "Taken back" : `${c.declinedBy === "rosa" ? "Mom" : "You"} said no`}</strong> · {fmtDate(c.resolvedAt ?? c.at)}
                <div>{c.summary.map(forPriya).join("; ")}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FamilyHistory({ state, onOpen }: { state: AppState; onOpen: (id: string) => void }) {
  const items = state.checkIns.filter((c) => c.phase === "resolved" || c.risk);
  const blocks = state.transactions.filter((t) => t.status === "blocked" && !t.checkInId);
  return (
    <div className="fade-up">
      <h1 className="fam-h1 sm">Previous incidents</h1>
      <p className="fam-lead">Every check-in and every stopped payment, with the conversation.</p>
      {items.length === 0 && blocks.length === 0 && <p className="muted pad">Nothing yet.</p>}
      <ul className="fam-incidents">
        {items.map((c) => {
          const t = state.transactions.find((x) => x.id === c.txnId);
          if (!t) return null;
          return (
            <li key={c.id}>
              <button className="inc-btn" onClick={() => onOpen(c.id)}>
                <div className="ib-top">
                  <StatusChip status={t.status} />
                  <span className="ib-date">
                    {fmtDay(c.startedAt)} {fmtTime(c.startedAt)}
                  </span>
                </div>
                <div className="ib-title">
                  {fmtMoney(t.amount)} at {t.merchant}
                </div>
                <div className="ib-sub">{forPriya(c.outcomeHeadline ?? "Check-in in progress")}</div>
              </button>
            </li>
          );
        })}
        {blocks.map((t) => (
          <li key={t.id}>
            <div className="inc-btn static">
              <div className="ib-top">
                <StatusChip status={t.status} />
                <span className="ib-date">
                  {fmtDay(t.time)} {fmtTime(t.time)}
                </span>
              </div>
              <div className="ib-title">
                {fmtMoney(t.amount)} at {t.merchant}
              </div>
              <div className="ib-sub">{t.reason}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
