// DETERMINISTIC POLICY ENGINE.
// Policy is code, not prompt. Nothing in this file calls a model, and no model output can
// produce a "release" or "approve": the AI can only hand in a RiskSignal, which can only
// keep a payment paused or (if Rosa opted into the scam-safety rule) turn it into a block.

import type {
  AuthorizationDecision,
  CardAuthorization,
  CheckInOutcome,
  MerchantStats,
  PaymentRequest,
  RiskSignal,
  RuleAgreement,
  SafetyRule,
  ScamPattern,
  ScamRisk,
  Transaction,
  TxnStatus,
} from "./types";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: n % 1 === 0 ? 0 : 2 });

/** Whole-dollar amount for speech and plain-English text: $31.41 -> "$31". */
export const roughMoney = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Per-merchant spending stats computed from Rosa's (synthetic) history. */
export function computeStats(history: Pick<Transaction, "merchantId" | "merchant" | "category" | "amount" | "status">[]): MerchantStats[] {
  const by = new Map<string, { merchant: string; category: string; amounts: number[] }>();
  for (const t of history) {
    if (t.status !== "approved") continue;
    const e = by.get(t.merchantId) ?? { merchant: t.merchant, category: t.category, amounts: [] };
    e.amounts.push(t.amount);
    by.set(t.merchantId, e);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return [...by.entries()].map(([merchantId, e]) => {
    const s = [...e.amounts].sort((a, b) => a - b);
    return {
      merchantId,
      merchant: e.merchant,
      category: e.category,
      count: s.length,
      median: round(quantile(s, 0.5)),
      p90: round(quantile(s, 0.9)),
      max: round(s[s.length - 1]),
      typicalLow: round(quantile(s, 0.1)),
      typicalHigh: round(quantile(s, 0.9)),
    };
  });
}

/** Rules only take effect once BOTH Rosa and Priya have signed. The scam-safety rule also needs Rosa's opt-in. */
export function activeRules(rules: SafetyRule[], agreement: RuleAgreement): SafetyRule[] {
  if (!agreement.rosaSignedAt || !agreement.priyaSignedAt) return [];
  return rules.filter((r) => r.enabled && (r.kind !== "scam_safety_block" || agreement.scamSafetyOptIn));
}

export function rulesAgreed(agreement: RuleAgreement) {
  return Boolean(agreement.rosaSignedAt && agreement.priyaSignedAt);
}

/** Evaluate a card authorization against Rosa's co-signed rules. Card-side data only. */
export function evaluateAuthorization(
  auth: CardAuthorization,
  rules: SafetyRule[],
  agreement: RuleAgreement,
  stats: MerchantStats[],
): AuthorizationDecision {
  if (!Number.isFinite(auth.amount) || auth.amount <= 0) {
    throw new Error("Invalid authorization amount");
  }
  const usual = stats.find((s) => s.merchantId === auth.merchantId);
  const active = activeRules(rules, agreement);

  // 1. Hard blocks first (VTC funds-transfer / MCC controls).
  const transferType = auth.transactionType === "funds_transfer" || auth.transactionType === "quasi_cash";
  const block = active.find(
    (r) => r.kind === "funds_transfer_block" && ((r.params.mccs ?? []).includes(auth.mcc) || transferType),
  );
  if (block) {
    return {
      decision: "decline",
      status: "blocked",
      firedRuleIds: [block.id],
      reason: `${transferType ? "Money transfers" : `${auth.category} payments`} are always stopped under a rule Rosa and Priya agreed on.`,
      usual,
    };
  }

  // 2. Check-in rules.
  const fired: string[] = [];
  const reasons: string[] = [];
  for (const r of active) {
    if (r.kind === "single_purchase_checkin") {
      const t = r.params.thresholdUsd ?? Infinity;
      const ch = r.params.channels ?? ["in_store", "online"];
      if (auth.amount > t && ch.includes(auth.channel)) {
        fired.push(r.id);
        reasons.push(`it is over the ${money(t)} check-in amount Rosa and Priya agreed on`);
      }
    }
    if (r.kind === "merchant_anomaly_checkin" && usual && usual.count >= 5) {
      const mult = r.params.multipleOfUsualMax ?? 4;
      const min = r.params.minAmountUsd ?? 0;
      if (auth.amount > usual.typicalHigh * mult && auth.amount >= min) {
        fired.push(r.id);
        reasons.push(
          `Rosa usually spends ${roughMoney(usual.typicalLow)}–${roughMoney(usual.typicalHigh)} at ${usual.merchant} (this is about ${Math.round(auth.amount / usual.median)}× her typical visit)`,
        );
      }
    }
  }
  if (fired.length) {
    return {
      decision: "pause",
      status: "paused",
      firedRuleIds: fired,
      reason: `Paused for a quick check-in because ${reasons.join(", and ")}.`,
      usual,
    };
  }
  return { decision: "approve", status: "approved", firedRuleIds: [], reason: "Within Rosa's usual pattern.", usual };
}

// ---------------------------------------------------------------------------------------------
// Risk signals (from the AI and the deterministic classifier)
// ---------------------------------------------------------------------------------------------

const RISK_ORDER: ScamRisk[] = ["none", "low", "medium", "high"];
const PATTERNS: ScamPattern[] = [
  "tech_support_impersonation",
  "government_impersonation",
  "bank_impersonation",
  "family_emergency",
  "romance",
  "prize_or_lottery",
  "utility_shutoff",
  "phone_pressure_purchase",
  "none",
  "unclear",
];
const PAYMENTS: PaymentRequest[] = ["gift_cards", "wire_transfer", "crypto", "cash", "none", "unknown"];

/**
 * Strictly whitelist a risk signal from an untrusted source (e.g. model output).
 * Unknown fields (like "release": true or "decision": "approve") are dropped.
 * Malformed values become conservative defaults ("unclear", not "none").
 */
export function sanitizeRiskSignal(raw: unknown, rosaWords: string): RiskSignal {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const risk = RISK_ORDER.includes(o.scam_risk as ScamRisk) ? (o.scam_risk as ScamRisk) : "medium";
  const pattern = PATTERNS.includes(o.pattern as ScamPattern) ? (o.pattern as ScamPattern) : "unclear";
  const payment = PAYMENTS.includes(o.payment_request as PaymentRequest) ? (o.payment_request as PaymentRequest) : "unknown";
  const pressure = Array.isArray(o.pressure_signals)
    ? o.pressure_signals.filter((x): x is string => typeof x === "string").slice(0, 6).map((s) => s.slice(0, 120))
    : [];
  // Evidence must be Rosa's actual words: if the quote is not a substring of what she said, use her words.
  const quote = typeof o.evidence_quote === "string" ? o.evidence_quote.trim() : "";
  const evidence =
    quote && rosaWords.toLowerCase().includes(quote.toLowerCase().replace(/^["']|["']$/g, "")) ? quote : rosaWords.trim();
  const detectors = Array.isArray(o.detectors) ? o.detectors.filter((x): x is string => typeof x === "string") : [];
  return {
    scam_risk: risk,
    pattern,
    payment_request: payment,
    pressure_signals: pressure,
    rosa_says_own_purchase: o.rosa_says_own_purchase === true,
    evidence_quote: evidence.slice(0, 300),
    source: "rosa_answer",
    detectors,
  };
}

/** Combine signals. Risk can only go UP: a model saying "none" never lowers a rule-based "high". */
export function combineRisk(...signals: (RiskSignal | undefined)[]): RiskSignal {
  const list = signals.filter(Boolean) as RiskSignal[];
  if (!list.length) throw new Error("No risk signals to combine");
  const top = [...list].sort((a, b) => RISK_ORDER.indexOf(b.scam_risk) - RISK_ORDER.indexOf(a.scam_risk))[0];
  const specificPattern = list.map((s) => s.pattern).find((p) => p !== "none" && p !== "unclear");
  const specificPayment = list.map((s) => s.payment_request).find((p) => p !== "none" && p !== "unknown");
  return {
    ...top,
    pattern: top.scam_risk === "none" ? top.pattern : (specificPattern ?? top.pattern),
    payment_request: specificPayment ?? top.payment_request,
    pressure_signals: [...new Set(list.flatMap((s) => s.pressure_signals))].slice(0, 6),
    // Only counts as "own purchase" if no detector found risk.
    rosa_says_own_purchase: list.every((s) => s.scam_risk === "none" || s.scam_risk === "low") && list.some((s) => s.rosa_says_own_purchase),
    detectors: [...new Set(list.flatMap((s) => s.detectors))],
  };
}

export const isScamFlag = (s: RiskSignal) => s.scam_risk === "medium" || s.scam_risk === "high";
export const isLikelyScam = (s: RiskSignal) => s.scam_risk === "high";

export interface RiskDecision {
  status: TxnStatus;
  outcome: CheckInOutcome;
  scamFlag: boolean;
  addedRuleIds: string[];
  explanation: string;
}

/**
 * Apply a risk signal to a transaction. Fixed code decides; the only possible results are
 * "stays as it is" (paused/blocked) or "paused -> blocked". This function cannot release.
 */
export function applyRiskSignal(
  txn: Pick<Transaction, "status">,
  signal: RiskSignal,
  rules: SafetyRule[],
  agreement: RuleAgreement,
): RiskDecision {
  const scamFlag = isScamFlag(signal);
  if (txn.status !== "paused") {
    // Already blocked (or never paused): nothing the AI says changes it.
    return {
      status: txn.status,
      outcome: txn.status === "blocked" ? "blocked_scam" : "paused_unclear",
      scamFlag,
      addedRuleIds: [],
      explanation: "This payment is not waiting on a check-in, so the conversation does not change it.",
    };
  }
  const scamRule = activeRules(rules, agreement).find((r) => r.kind === "scam_safety_block");
  if (isLikelyScam(signal) && scamRule) {
    return {
      status: "blocked",
      outcome: "blocked_scam",
      scamFlag: true,
      addedRuleIds: [scamRule.id],
      explanation:
        "Rosa's answer showed likely scam signals, and Rosa chose the scam-safety rule during setup, so the payment is now blocked. Only Rosa and Priya together can change that.",
    };
  }
  if (scamFlag) {
    return {
      status: "paused",
      outcome: "paused_concern",
      scamFlag: true,
      addedRuleIds: [],
      explanation: scamRule
        ? "Rosa's answer raised a concern, so the payment stays paused and cannot be continued alone. Priya has been told."
        : "Rosa's answer raised a scam concern. The scam-safety rule is not turned on, so the payment stays paused (not blocked) and cannot be continued alone. Priya has been told.",
    };
  }
  return {
    status: "paused",
    outcome: "paused_unclear",
    scamFlag: false,
    addedRuleIds: [],
    explanation: "No scam signs in Rosa's answer. The payment waits until Rosa confirms it was her.",
  };
}

export interface ReleaseResult {
  ok: boolean;
  status: TxnStatus;
  reason: string;
}

/**
 * The ONLY path from "paused" to "released": Rosa's explicit confirmation, a rule set that
 * allows self-release, and no scam flag. Blocked payments can never be released here.
 */
export function releaseByRosa(
  txn: Pick<Transaction, "status" | "firedRuleIds">,
  rules: SafetyRule[],
  opts: { explicitConfirmation: boolean; scamFlag: boolean },
): ReleaseResult {
  if (txn.status === "blocked") {
    return { ok: false, status: "blocked", reason: "This payment is blocked under a rule Rosa and Priya agreed on. It can only be changed by both of them together." };
  }
  if (txn.status !== "paused") {
    return { ok: false, status: txn.status, reason: "This payment is not waiting on a check-in." };
  }
  if (!opts.explicitConfirmation) {
    return { ok: false, status: "paused", reason: "Rosa needs to confirm clearly that this purchase was hers." };
  }
  if (opts.scamFlag) {
    return { ok: false, status: "paused", reason: "Rosa's answer raised scam concerns, so this payment can't be continued alone. Please talk with Priya first." };
  }
  const fired = rules.filter((r) => txn.firedRuleIds.includes(r.id));
  if (!fired.length || fired.some((r) => r.releaseBy !== "rosa_self")) {
    return { ok: false, status: "paused", reason: "The rule that paused this payment needs both Rosa and Priya to change it." };
  }
  return { ok: true, status: "released", reason: "Rosa confirmed it was her. She can use her card again for this purchase." };
}

export { money };
