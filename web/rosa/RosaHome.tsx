import { useState } from "react";
import type { AppState, Transaction } from "../../shared/types";
import { fmtDay, fmtMoney, fmtTime } from "../state";
import { Icon, SimTag, StatusChip } from "../ui";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function RosaHome({ state, onWhy, whyText, onCloseWhy }: { state: AppState; onWhy: (txnId: string) => void; whyText?: string; onCloseWhy: () => void }) {
  const [openId, setOpenId] = useState<string>();
  const live = state.transactions;
  const recent: Transaction[] = [...live, ...state.history].slice(0, 8);
  const notice = state.rosaNotice;
  const lastIncident = state.checkIns.find((c) => c.phase === "resolved" && (c.outcome === "blocked_scam" || c.outcome === "paused_concern"));
  const lastIncidentRecent = lastIncident && Date.now() - new Date(lastIncident.resolvedAt ?? lastIncident.startedAt).getTime() < 24 * 3600 * 1000;
  const stores = state.profile.preferredStores.map((p) => ({ p, s: state.stats.find((x) => x.merchantId === p.merchantId) })).filter((x) => x.s);

  return (
    <div className="home fade-up">
      <section className="home-hero">
        <h1 className="display">
          {greeting()}, {state.profile.preferredName}.
        </h1>
        {notice && Date.now() - new Date(notice.at).getTime() < 24 * 3600 * 1000 ? (
          <div className="notice notice-alert">
            <Icon name="stop" size={26} />
            <div>
              <div className="notice-title">{notice.title}</div>
              <div className="notice-body">{notice.body}</div>
            </div>
          </div>
        ) : lastIncidentRecent ? (
          <p className="status-line status-protected">
            <span className="status-dot" /> You're safe. The scam payment stayed stopped, and Priya knows.
          </p>
        ) : (
          <p className="status-line">
            <span className="status-dot" /> Everything looks normal. Your helper is watching quietly.
          </p>
        )}
      </section>

      <div className="home-grid">
        <section className="panel">
          <h2 className="section-title">
            <Icon name="card" size={20} /> Recent purchases
          </h2>
          <ul className="txn-list">
            {recent.map((t) => {
              const isLive = live.includes(t);
              const open = openId === t.id;
              return (
                <li key={t.id} className={`txn-item${isLive ? " txn-new" : ""}`}>
                  <button className="txn-row" aria-expanded={open} onClick={() => {
                    if (open) {
                      setOpenId(undefined);
                      onCloseWhy();
                    } else {
                      setOpenId(t.id);
                      if (isLive) onWhy(t.id);
                    }
                  }}>
                    <div className="txn-main">
                      <div className="txn-merchant">{t.merchant}</div>
                      <div className="txn-sub">
                        {fmtDay(t.time)} · {fmtTime(t.time)} · {t.category}
                      </div>
                    </div>
                    <div className="txn-right">
                      <div className="txn-amount">{fmtMoney(t.amount)}</div>
                      <div className="txn-tags">
                        <StatusChip status={t.status} />
                        <SimTag />
                      </div>
                    </div>
                  </button>
                  {open && (
                    <div className="txn-why fade-up">
                      <Icon name="question" size={18} />
                      <p>{isLive ? (whyText ?? "One moment…") : "This was a normal purchase from your past year of shopping (sample data)."}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="fine">Tap a purchase to see why it was normal, paused or blocked. All card activity here is SIMULATED, not real Visa authorizations; the earlier year is labeled sample data.</p>
        </section>

        <div className="home-side">
          <section className="panel">
            <h2 className="section-title">
              <Icon name="store" size={20} /> Your usual stores
            </h2>
            <ul className="store-list">
              {stores.map(({ p, s }) => (
                <li key={p.merchantId}>
                  <span className="store-name">{p.name}</span>
                  <span className="store-range">
                    usually {fmtMoney(Math.round(s!.typicalLow))}–{fmtMoney(Math.round(s!.typicalHigh))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel panel-soft">
            <h2 className="section-title">
              <Icon name="heart" size={20} /> My usual list
            </h2>
            <p className="usual-list">{state.profile.recurringItems.join(" · ")}</p>
          </section>
          <section className="panel panel-soft">
            <h2 className="section-title">
              <Icon name="card" size={20} /> My card
            </h2>
            <p className="usual-list">
              {state.provider.cardLabel}
              <br />
              <span className="fine-inline">Connected to a simulated card network for now.</span>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
