import { useState } from "react";
import type { AppState, RuleEdit } from "../../shared/types";
import { fmtDate, fmtTime, useApi } from "../state";
import { Icon, RuleEditor } from "../ui";

export function RosaRules({ state, onError }: { state: AppState; onError: (m: string) => void }) {
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const big = state.rules.find((r) => r.kind === "single_purchase_checkin")!;
  const store = state.rules.find((r) => r.kind === "merchant_anomaly_checkin")!;
  const current = { thresholdUsd: big.params.thresholdUsd ?? 200, unusualStoreCheck: store.enabled, scamSafety: state.agreement.scamSafetyOptIn };
  const [draft, setDraft] = useState(current);
  const pending = state.ruleChanges.find((c) => c.status === "pending");
  const past = state.ruleChanges.filter((c) => c.status !== "pending").slice(0, 4);
  const agreedAt = [state.agreement.rosaSignedAt, state.agreement.priyaSignedAt].sort()[1];

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const changed: RuleEdit = {};
  if (draft.thresholdUsd !== current.thresholdUsd) changed.thresholdUsd = draft.thresholdUsd;
  if (draft.unusualStoreCheck !== current.unusualStoreCheck) changed.unusualStoreCheck = draft.unusualStoreCheck;
  if (draft.scamSafety !== current.scamSafety) changed.scamSafety = draft.scamSafety;

  return (
    <div className="rules-page fade-up">
      <h1 className="display sm">My safety rules</h1>
      <p className="lead">These are the rules you and Priya agreed on. Changing one needs both of you.</p>

      {pending && (
        <section className={`proposal ${pending.proposedBy === "priya" ? "from-other" : "mine"}`}>
          <div className="proposal-head">
            <Icon name="rules" size={22} />
            {pending.proposedBy === "priya" ? `Priya suggested a change · ${fmtTime(pending.at)}` : `You suggested a change · waiting for Priya`}
          </div>
          <ul className="proposal-list">
            {pending.summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {pending.proposedBy === "priya" ? (
            <div className="proposal-actions">
              <button className="btn btn-confirm btn-lg" disabled={busy} onClick={() => run(() => api("/rules/respond", { who: "rosa", changeId: pending.id, accept: true }))}>
                <Icon name="check" size={22} stroke={2.6} /> I agree
              </button>
              <button className="btn btn-outline btn-lg" disabled={busy} onClick={() => run(() => api("/rules/respond", { who: "rosa", changeId: pending.id, accept: false }))}>
                No, keep my rules
              </button>
            </div>
          ) : (
            <div className="proposal-actions">
              <button className="btn btn-ghost btn-lg" disabled={busy} onClick={() => run(() => api("/rules/respond", { who: "rosa", changeId: pending.id, accept: false }))}>
                Take back my suggestion
              </button>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <ul className="rules-read">
          {state.rules
            .filter((r) => r.kind !== "scam_safety_block" || state.agreement.scamSafetyOptIn)
            .filter((r) => r.enabled)
            .map((r) => (
              <li key={r.id}>
                <Icon name={r.action === "check_in" ? "chat" : "lock"} size={22} />
                <div>
                  <div className="rr-title">{r.title}</div>
                  <div className="rr-detail">{r.detail}</div>
                </div>
              </li>
            ))}
        </ul>
        {agreedAt && (
          <p className="agreed-by">
            <Icon name="check" size={16} stroke={2.6} /> Agreed by Rosa and Priya · {fmtDate(agreedAt)}
          </p>
        )}
      </section>

      {!pending &&
        (editing ? (
          <section className="panel edit-panel fade-up">
            <h2 className="section-title">Suggest a change</h2>
            <RuleEditor
              threshold={draft.thresholdUsd}
              unusualStore={draft.unusualStoreCheck}
              scamSafety={draft.scamSafety}
              canEditScam
              onChange={(e) =>
                setDraft((d) => ({
                  thresholdUsd: e.thresholdUsd ?? d.thresholdUsd,
                  unusualStoreCheck: e.unusualStoreCheck ?? d.unusualStoreCheck,
                  scamSafety: e.scamSafety ?? d.scamSafety,
                }))
              }
            />
            <div className="proposal-actions">
              <button
                className="btn btn-primary btn-lg"
                disabled={busy || Object.keys(changed).length === 0}
                onClick={() =>
                  run(async () => {
                    await api("/rules/edit", { who: "rosa", edit: changed });
                    setEditing(false);
                  })
                }
              >
                Send to Priya
              </button>
              <button
                className="btn btn-ghost btn-lg"
                onClick={() => {
                  setDraft(current);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </div>
          </section>
        ) : (
          <button
            className="btn btn-outline btn-lg"
            onClick={() => {
              setDraft(current);
              setEditing(true);
            }}
          >
            <Icon name="rules" size={22} /> Change a rule
          </button>
        ))}

      {past.length > 0 && (
        <section className="panel panel-soft">
          <h2 className="section-title">Earlier changes</h2>
          <ul className="past-changes">
            {past.map((c) => (
              <li key={c.id}>
                <strong>{c.status === "agreed" ? "Agreed by both" : c.declinedBy === c.proposedBy ? "Taken back" : `Not agreed by ${c.declinedBy === "rosa" ? "you" : "Priya"}`}</strong> · {fmtDate(c.resolvedAt ?? c.at)}
                <div>{c.summary.join("; ")}</div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
