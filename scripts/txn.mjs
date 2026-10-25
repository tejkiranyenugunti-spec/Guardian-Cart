#!/usr/bin/env node
// Push a SIMULATED card authorization into GuardianCart, like a card network webhook would.
// Usage: npm run txn -- --merchant "CVS Pharmacy" --mcc 5912 --amount 500 [--channel online] [--type funds_transfer] [--household stage]
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
if (args.includes("--help") || !get("merchant")) {
  console.log('Usage: npm run txn -- --merchant "CVS Pharmacy" --mcc 5912 --amount 500 [--channel in_store|online] [--type purchase|funds_transfer|quasi_cash|cash_withdrawal] [--id txn_123] [--household home|stage]');
  process.exit(args.includes("--help") ? 0 : 1);
}
const base = process.env.BASE ?? `http://localhost:${process.env.PORT ?? 8787}`;
const household = get("household", "home");
const body = {
  transaction_id: get("id"),
  merchant: get("merchant"),
  merchant_category: get("mcc", "5999"),
  amount: Number(get("amount")),
  channel: get("channel", "in_store"),
  transaction_type: get("type", "purchase"),
  timestamp: new Date().toISOString(),
};
try {
  const res = await fetch(`${base}/api/${household}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) {
    console.error(`Rejected (${res.status}): ${json.error}`);
    process.exit(1);
  }
  console.log(`SIMULATED authorization ${json.transaction_id}: ${json.decision.toUpperCase()} -> ${json.status}`);
  console.log(`  ${json.reason}`);
} catch {
  console.error(`Could not reach GuardianCart at ${base}. Is the server running (npm start)?`);
  process.exit(1);
}
