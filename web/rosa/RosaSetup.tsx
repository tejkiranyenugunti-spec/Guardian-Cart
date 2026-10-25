import { useState } from "react";
import type { AppState, RuleEdit } from "../../shared/types";
import { fmtTime, useApi } from "../state";
import { Icon, THRESHOLD_CHOICES } from "../ui";

export function RosaSetup({ state, onError }: { state: AppState; onError: (m: string) => void }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const a = state.agreement;
  const rosaSigned = Boolean(a.rosaSignedAt);

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
  const edit = (e: RuleEdit) => run(() => api("/rules/edit", { who: "rosa", edit: e }));

  return (
    <div className="setup fade-up">
      <div className="setup-intro">
        <p className="eyebrow">Set up together with Priya</p>
        <h1 className="display">Your safety rules, Rosa</h1>
        <p className="lead">
          Priya suggested these rules for your card. Nothing changes about how you shop. Your helper stays quiet unless something looks unusual.
          <strong> You decide, and you can change them.</strong>
        </p>
      </div>

      <ol className="rule-list">
        {state.rules.map((r, i) => {
          const isScam = r.kind === "scam_safety_block";
          const isStore = r.kind === "merchant_anomaly_checkin";
          const on = isScam ? a.scamSafetyOptIn : r.enabled;
          return (
            <li key={r.id} className={`rule-row${isScam ? " rule-optin" : ""}${isScam && on ? " is-on" : ""}${!on ? " is-off" : ""}`}>
              <span className="rule-num">{i + 1}</span>
              <div className="rule-text">
                <div className="rule-title">{r.title}</div>
                <div className="rule-detail">{r.detail}</div>
                {r.kind === "single_purchase_checkin" ? (
                  <div className="re-chips setup-chips" role="radiogroup" aria-label="Check-in amount">
                    {THRESHOLD_CHOICES.map((t) => (
                      <button key={t} role="radio" aria-checked={t === r.params.thresholdUsd} className={`re-chip${t === r.params.thresholdUsd ? " on" : ""}`} disabled={busy} onClick={() => edit({ thresholdUsd: t })}>
                        ${t}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rule-tags">
                    <span className={`tag tag-${r.action}`}>{r.action === "check_in" ? "Checks in with me" : "Keeps it stopped"}</span>
                    <span className="tag tag-quiet">{r.releaseBy === "rosa_self" ? "I can continue on my own" : "Only Rosa and Priya together can undo"}</span>
                  </div>
                )}
              </div>
              {(isScam || isStore) && (
                <button
                  className={`switch${on ? " on" : ""}`}
                  role="switch"
                  aria-checked={on}
                  aria-label={r.title}
                  disabled={busy || (isScam && rosaSigned)}
                  onClick={() => edit(isScam ? { scamSafety: !on } : { unusualStoreCheck: !on })}
                >
                  <span className="switch-knob" />
                  <span className="switch-label">{on ? (isScam ? "On, my choice" : "On") : "Off"}</span>
                </button>
              )}
            </li>
          );
        })}
      </ol>

      <div className="setup-sign">
        <div className="sign-status">
          <SignLine who="Priya" at={a.priyaSignedAt} />
          <SignLine who="Rosa" at={a.rosaSignedAt} />
        </div>
        {rosaSigned ? (
          <p className="waiting">
            <span className="pulse-dot" /> Thank you, Rosa. Waiting for Priya to agree on her phone.
          </p>
        ) : (
          <button className="btn btn-primary btn-xl" disabled={busy} onClick={() => run(() => api("/setup/sign", { who: "rosa" }))}>
            <Icon name="check" size={26} stroke={2.6} /> I agree to these rules
          </button>
        )}
      </div>
    </div>
  );
}

function SignLine({ who, at }: { who: string; at?: string }) {
  return (
    <div className={`sign-line${at ? " signed" : ""}`}>
      <span className="sign-check">{at ? <Icon name="check" size={16} stroke={3} /> : null}</span>
      <span>
        <strong>{who}</strong> {at ? `agreed at ${fmtTime(at)}` : "hasn't agreed yet"}
      </span>
    </div>
  );
}
