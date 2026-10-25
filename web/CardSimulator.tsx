// Stands in for the card network (Visa). Not part of Rosa's or Priya's app.
import { useState } from "react";
import { MCC } from "../shared/data";
import { api, fmtMoney, fmtTime, useAppState } from "./state";
import { Icon, SimTag, StatusChip } from "./ui";

const PRESETS = [
  { label: "Groceries", merchant: "Safeway", mcc: "5411", amount: 46.18, channel: "in_store", type: "purchase" },
  { label: "Coffee", merchant: "Peet's Coffee", mcc: "5814", amount: 6.4, channel: "in_store", type: "purchase" },
  { label: "$500 at CVS", merchant: "CVS Pharmacy", mcc: "5912", amount: 500, channel: "in_store", type: "purchase" },
  { label: "Walker", merchant: "Bay Mobility & Medical", mcc: "5976", amount: 640, channel: "in_store", type: "purchase" },
  { label: "Wire", merchant: "QuickWire Transfer", mcc: "4829", amount: 900, channel: "online", type: "funds_transfer" },
];

export function CardSimulator() {
  const { state } = useAppState();
  const [form, setForm] = useState(PRESETS[0]);
  const [result, setResult] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api<{ status: string; decision: string; reason: string; transaction_id: string }>("/home/transactions", {
        merchant: form.merchant,
        merchant_category: form.mcc,
        amount: Number(form.amount),
        channel: form.channel,
        transaction_type: form.type,
      });
      setResult(`${r.transaction_id}: ${r.decision.toUpperCase()} (${r.status}). ${r.reason}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sim-page">
      <div className="sim-inner">
        <header className="sim-head">
          <div>
            <p className="eyebrow">Developer tool · not part of Rosa's or Priya's app</p>
            <h1 className="fam-h1">Simulated card network</h1>
            <p className="fam-lead">
              Sends a card authorization to GuardianCart through <code>SimulatedTransactionProvider</code>, the same way a real network would push one. Card {state?.provider.cardLabel ?? "…"}. Card-side fields only: no items.
            </p>
          </div>
          <SimTag long />
        </header>

        <div className="sim-presets">
          {PRESETS.map((p) => (
            <button key={p.label} className={`re-chip${form.label === p.label ? " on" : ""}`} onClick={() => setForm(p)}>
              {p.label}
            </button>
          ))}
        </div>

        <form
          className="sim-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            Merchant
            <input value={form.merchant} onChange={(e) => setForm({ ...form, label: "", merchant: e.target.value })} />
          </label>
          <label>
            Merchant category (MCC)
            <select value={form.mcc} onChange={(e) => setForm({ ...form, label: "", mcc: e.target.value })}>
              {Object.entries(MCC).map(([k, v]) => (
                <option key={k} value={k}>
                  {k} · {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount (USD)
            <input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, label: "", amount: Number(e.target.value) })} />
          </label>
          <label>
            Channel
            <select value={form.channel} onChange={(e) => setForm({ ...form, label: "", channel: e.target.value })}>
              <option value="in_store">In store</option>
              <option value="online">Online</option>
            </select>
          </label>
          <label>
            Transaction type
            <select value={form.type} onChange={(e) => setForm({ ...form, label: "", type: e.target.value })}>
              <option value="purchase">Purchase</option>
              <option value="funds_transfer">Funds transfer</option>
              <option value="quasi_cash">Quasi-cash</option>
              <option value="cash_withdrawal">Cash withdrawal</option>
            </select>
          </label>
          <button className="btn btn-primary btn-lg" disabled={busy} type="submit">
            <Icon name="card" size={20} /> Send authorization
          </button>
        </form>
        {result && <p className="sim-result">{result}</p>}
        {err && <p className="sim-error">{err}</p>}

        <h2 className="fam-h2 sim-recent">Recent authorizations on this card</h2>
        <ul className="fam-txns">
          {(state?.transactions ?? []).length === 0 && <li className="muted">No authorizations yet.</li>}
          {(state?.transactions ?? []).slice(0, 8).map((t) => (
            <li key={t.id}>
              <div>
                <div className="ft-merchant">
                  {t.merchant} · {fmtMoney(t.amount)}
                </div>
                <div className="ft-sub">
                  {t.id} · {fmtTime(t.time)} · MCC {t.mcc} · {t.channel === "in_store" ? "in store" : "online"}
                </div>
              </div>
              <StatusChip status={t.status} />
            </li>
          ))}
        </ul>
        <p className="fine">
          CLI: <code>npm run txn -- --merchant "CVS Pharmacy" --mcc 5912 --amount 500</code> · Webhook: <code>POST /api/transactions</code>
        </p>
      </div>
    </div>
  );
}
