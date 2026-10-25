// Deterministic scam-phrase classifier. Runs on EVERY answer, alongside Claude, and is the
// complete fallback when Claude is unavailable. Its result is combined with Claude's using
// combineRisk(), so risk can only go up.
import type { PaymentRequest, RiskSignal, ScamPattern } from "./types";

interface Hit {
  label: string;
  re: RegExp;
}

const IMPERSONATION: { pattern: ScamPattern; hits: Hit[] }[] = [
  {
    pattern: "tech_support_impersonation",
    hits: [
      { label: "says he is from Microsoft", re: /\bmicro ?soft\b|\bwindows\b/i },
      { label: "says he is from Apple / Amazon support", re: /\b(apple|amazon|geek squad|tech support|computer (guy|man|support))\b/i },
      { label: "computer virus / hacked", re: /\b(virus|hacked|hacker|remote access|pop[- ]?up)\b/i },
    ],
  },
  {
    pattern: "government_impersonation",
    hits: [
      { label: "says he is from the government", re: /\b(irs|social security|medicare|government|police|sheriff|fbi|warrant|tax(es)? office)\b/i },
      { label: "threat of arrest", re: /\b(arrest(ed)?|jail time|lawsuit)\b/i },
    ],
  },
  {
    pattern: "bank_impersonation",
    hits: [{ label: "says he is from the bank", re: /\b(bank|fraud department|safe account)\b/i }],
  },
  {
    pattern: "family_emergency",
    hits: [{ label: "relative in trouble", re: /\b(grand(son|daughter|child|kid)|nephew|niece)\b.*\b(jail|trouble|hospital|accident|bail|lawyer)\b|\bbail\b/i }],
  },
  {
    pattern: "romance",
    hits: [{ label: "online friend / sweetheart", re: /\b(boyfriend|girlfriend|sweetheart|online friend|met (him|her) online)\b/i }],
  },
  {
    pattern: "prize_or_lottery",
    hits: [{ label: "prize or lottery", re: /\b(won|winner|prize|lottery|sweepstakes)\b/i }],
  },
  {
    pattern: "utility_shutoff",
    hits: [{ label: "utility shutoff threat", re: /\b(pg&?e|power|electric|water|gas) (company|bill)\b.*\b(shut|off|cut)\b|\bshut (it |my power )?off\b/i }],
  },
];

const PAYMENT: { kind: PaymentRequest; re: RegExp; label: string }[] = [
  { kind: "gift_cards", re: /\bgift ?cards?\b|\b(itunes|google play|apple|target|steam|amazon|ebay|walmart) cards?\b|\bprepaid cards?\b|\bcards? numbers\b|\bnumbers on the back\b/i, label: "asked to buy gift cards" },
  { kind: "wire_transfer", re: /\b(wire|western union|moneygram|zelle|venmo|send (the )?money)\b/i, label: "asked to send money" },
  { kind: "crypto", re: /\b(bitcoin|crypto|btc|bitcoin atm)\b/i, label: "asked for crypto" },
  { kind: "cash", re: /\b(cash|withdraw)\b/i, label: "asked for cash" },
];

const PRESSURE: Hit[] = [
  { label: "someone on the phone", re: /\b(on the phone|phone call|called me|calling me|caller|on the line|he called|she called|man on the phone|lady on the phone)\b/i },
  { label: "told what to buy", re: /\b(told me (to|what|which)|said to|asked me to|wants me to|making me|instructed|tell(s|ing) me what)\b/i },
  { label: "urgency", re: /\b(right now|hurry|immediately|today or|before (it'?s|its) too late|quickly|urgent)\b/i },
  { label: "secrecy", re: /\b(don'?t tell|not tell|keep it (a )?secret|tell no ?one)\b/i },
];

const AFFIRM_PHONE = /^\s*(yes|yeah|yep|si|sí|uh[- ]?huh)\b/i;
const OWN_PURCHASE = /\b(this was me|that was me|it was me|it'?s (for )?me|i bought|my (own )?(walker|wheelchair|prescription|medicine|order)|for my (own )?(walker|wheelchair|knee|hip)|doctor (ordered|told)|i meant to|i wanted)\b/i;
const DENIAL = /^\s*(no|nope|nobody|no one|no,)\b/i;

export function classifyAnswer(raw: string): RiskSignal {
  const text = (raw ?? "").trim();
  const pressure: string[] = [];
  let pattern: ScamPattern = "none";
  for (const group of IMPERSONATION) {
    const hit = group.hits.find((h) => h.re.test(text));
    if (hit) {
      pattern = group.pattern;
      pressure.push(hit.label);
      break;
    }
  }
  let payment: PaymentRequest = "none";
  for (const p of PAYMENT) {
    if (p.re.test(text)) {
      payment = p.kind;
      pressure.push(p.label);
      break;
    }
  }
  for (const p of PRESSURE) if (p.re.test(text)) pressure.push(p.label);

  const onPhone = PRESSURE[0].re.test(text) || PRESSURE[1].re.test(text);
  // Answering "yes" to "Is someone on the phone asking you to buy something?"
  const affirmed = AFFIRM_PHONE.test(text) && !OWN_PURCHASE.test(text);
  const ownPurchase = OWN_PURCHASE.test(text) || (DENIAL.test(text) && !onPhone && pattern === "none" && payment === "none");

  let risk: RiskSignal["scam_risk"] = "none";
  if (pattern !== "none" && payment !== "none") risk = "high";
  else if ((onPhone || affirmed) && (payment !== "none" || pattern !== "none")) risk = "high";
  else if (pattern !== "none" && (PRESSURE[3].re.test(text) || PRESSURE[2].re.test(text) || onPhone)) risk = "high";
  else if (affirmed) risk = "high"; // "yes, someone on the phone is asking me to buy this" during an unusual payment
  else if (onPhone && PRESSURE[1].re.test(text)) risk = "high";
  else if (pattern !== "none" || payment === "gift_cards" || payment === "wire_transfer" || payment === "crypto") risk = "medium";
  else if (onPhone) risk = "medium";
  else if (!ownPurchase && text.length > 0) risk = "low";

  if (risk !== "none" && risk !== "low" && pattern === "none") pattern = "phone_pressure_purchase";
  if (affirmed && !pressure.includes("someone on the phone")) pressure.unshift("said yes, someone is on the phone");

  return {
    scam_risk: risk,
    pattern: risk === "low" ? "unclear" : pattern,
    payment_request: payment === "none" && (risk === "high" || risk === "medium") ? "unknown" : payment,
    pressure_signals: [...new Set(pressure)],
    rosa_says_own_purchase: ownPurchase && (risk === "none" || risk === "low"),
    evidence_quote: text.slice(0, 300),
    source: "rosa_answer",
    detectors: ["phrase_rules"],
  };
}

/** Short facts that came ONLY from Rosa's words (for the "From Rosa" panel). */
export function rosaFactsFrom(signal: RiskSignal): string[] {
  const out: string[] = [];
  const PATTERN_TEXT: Partial<Record<ScamPattern, string>> = {
    tech_support_impersonation: "A caller claiming to be tech support",
    government_impersonation: "A caller claiming to be from the government",
    bank_impersonation: "A caller claiming to be from her bank",
    family_emergency: "A caller claiming a relative is in trouble",
    romance: "An online friend asking for money",
    prize_or_lottery: "A caller promising a prize",
    utility_shutoff: "A caller threatening a utility shutoff",
    phone_pressure_purchase: "Someone on the phone telling her what to buy",
  };
  const PAY_TEXT: Partial<Record<PaymentRequest, string>> = {
    gift_cards: "Asked her to buy gift cards",
    wire_transfer: "Asked her to send money",
    crypto: "Asked her to pay with crypto",
    cash: "Asked her for cash",
  };
  const named = signal.evidence_quote.match(/\b(micro ?soft|apple|amazon|irs|social security|medicare)\b/i)?.[1];
  if (named && signal.pattern !== "none" && signal.pattern !== "unclear") out.push(`A caller claiming to be from ${named.replace(/^(irs)$/i, "the IRS").replace(/^micro ?soft$/i, "Microsoft").replace(/^\w/, (c) => c.toUpperCase())}`);
  else if (PATTERN_TEXT[signal.pattern]) out.push(PATTERN_TEXT[signal.pattern]!);
  if (PAY_TEXT[signal.payment_request]) out.push(PAY_TEXT[signal.payment_request]!);
  if (signal.rosa_says_own_purchase) out.push("Rosa says the purchase is her own");
  return out;
}
