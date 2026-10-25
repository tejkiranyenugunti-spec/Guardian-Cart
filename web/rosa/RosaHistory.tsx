import type { AppState, CheckIn } from "../../shared/types";
import { fmtDay, fmtMoney, fmtTime } from "../state";
import { Icon, StatusChip } from "../ui";

const OUTCOME_TEXT: Record<string, string> = {
  blocked_scam: "Sounded like a scam. The payment was blocked and you were told to hang up.",
  paused_concern: "Sounded like it could be a scam. The payment was kept on hold.",
  released_by_rosa: "You said it was your own purchase, so you continued.",
  paused_unclear: "Waiting for your answer.",
};

export function RosaHistory({ state }: { state: AppState }) {
  const items = state.checkIns.filter((c) => c.phase === "resolved");
  const blocks = state.transactions.filter((t) => t.status === "blocked" && !t.checkInId);
  return (
    <div className="history-page fade-up">
      <h1 className="display sm">Past check-ins</h1>
      <p className="lead">Each time your helper paused a payment, and what happened.</p>
      {items.length === 0 && blocks.length === 0 ? (
        <div className="empty">
          <Icon name="shield" size={34} />
          <p>No check-ins yet. Your helper only speaks up when something is unusual.</p>
        </div>
      ) : (
        <ul className="incident-list">
          {items.map((c) => (
            <Incident key={c.id} c={c} state={state} />
          ))}
          {blocks.map((t) => {
            const alert = state.alerts.find((a) => a.txnId === t.id);
            return (
              <li key={t.id} className="incident">
                <div className="inc-head">
                  <StatusChip status={t.status} big />
                  <span className="inc-what">
                    {fmtMoney(t.amount)} at {t.merchant} · {fmtDay(t.time)} {fmtTime(t.time)}
                  </span>
                </div>
                <p className="inc-outcome">Money transfers are always stopped, as you and Priya agreed.</p>
                {alert && <Notified at={alert.at} seen={alert.acknowledged ? alert.acknowledgedAt : undefined} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Incident({ c, state }: { c: CheckIn; state: AppState }) {
  const t = state.transactions.find((x) => x.id === c.txnId);
  const alert = state.alerts.find((a) => a.checkInId === c.id && a.level === "urgent");
  const rosaSaid = c.transcript.filter((l) => l.speaker === "rosa").map((l) => l.text);
  if (!t) return null;
  return (
    <li className="incident">
      <div className="inc-head">
        <StatusChip status={t.status} big />
        <span className="inc-what">
          {fmtMoney(t.amount)} at {t.merchant} · {fmtDay(c.startedAt)} {fmtTime(c.startedAt)}
        </span>
      </div>
      <p className="inc-outcome">{OUTCOME_TEXT[c.outcome ?? "paused_unclear"]}</p>
      {rosaSaid.length > 0 && <p className="inc-quote">You said: “{rosaSaid[0]}”</p>}
      {alert ? <Notified at={c.familyNotifiedAt ?? alert.at} seen={alert.acknowledged ? alert.acknowledgedAt : undefined} /> : c.outcome === "released_by_rosa" ? <p className="inc-note">Priya got a short note. Nothing for her to do.</p> : null}
    </li>
  );
}

function Notified({ at, seen }: { at: string; seen?: string }) {
  return (
    <p className="inc-notified">
      <Icon name="heart" size={18} /> Priya was told at {fmtTime(at)}
      {seen ? ` · she saw it at ${fmtTime(seen)}` : ""}
    </p>
  );
}
