// Fictional persona + LABELED-SYNTHETIC data. Rosa and Priya are not real people.
import type { CardAuthorization, Profile, SafetyRule, Transaction } from "./types";

export const PROFILE: Profile = {
  name: "Rosa Alvarez",
  preferredName: "Rosa",
  age: 78,
  city: "Daly City, CA",
  speechPreference: "Speak slowly and clearly. Use her first name. One question at a time.",
  trustedContact: { name: "Priya", relation: "daughter", phoneLabel: "Priya (daughter)" },
  preferredStores: [
    { merchantId: "safeway", name: "Safeway", category: "Groceries", note: "Weekly groceries, usually Tuesdays" },
    { merchantId: "cvs", name: "CVS Pharmacy", category: "Pharmacy", note: "Prescriptions and vitamins" },
    { merchantId: "traderjoes", name: "Trader Joe's", category: "Groceries", note: "Every other week" },
    { merchantId: "peets", name: "Peet's Coffee", category: "Cafe", note: "Saturday coffee with friends" },
    { merchantId: "ace", name: "Ace Hardware", category: "Hardware", note: "Now and then" },
  ],
  recurringItems: [
    "Whole milk",
    "Sourdough bread",
    "Bananas",
    "Eggs (dozen)",
    "Chamomile tea",
    "Oatmeal",
    "Vitamin D",
  ],
};

export const MCC: Record<string, string> = {
  "5411": "Grocery store",
  "5912": "Pharmacy",
  "5814": "Cafe / fast food",
  "5251": "Hardware store",
  "4900": "Utilities",
  "4899": "Cable / streaming",
  "8062": "Hospital / clinic",
  "5976": "Medical & mobility supplies",
  "4829": "Money transfer / wire",
  "6051": "Quasi-cash / crypto",
  "6540": "Stored-value card load",
};

interface StoreSeed {
  merchantId: string;
  merchant: string;
  mcc: string;
  channel: "in_store" | "online";
  perYear: number;
  low: number;
  high: number;
}

const STORE_SEEDS: StoreSeed[] = [
  { merchantId: "safeway", merchant: "Safeway", mcc: "5411", channel: "in_store", perYear: 52, low: 28, high: 74 },
  { merchantId: "cvs", merchant: "CVS Pharmacy", mcc: "5912", channel: "in_store", perYear: 30, low: 8, high: 52 },
  { merchantId: "traderjoes", merchant: "Trader Joe's", mcc: "5411", channel: "in_store", perYear: 26, low: 18, high: 55 },
  { merchantId: "peets", merchant: "Peet's Coffee", mcc: "5814", channel: "in_store", perYear: 48, low: 4, high: 12 },
  { merchantId: "ace", merchant: "Ace Hardware", mcc: "5251", channel: "in_store", perYear: 6, low: 9, high: 46 },
  { merchantId: "pge", merchant: "PG&E", mcc: "4900", channel: "online", perYear: 12, low: 62, high: 118 },
  { merchantId: "comcast", merchant: "Comcast Xfinity", mcc: "4899", channel: "online", perYear: 12, low: 79, high: 79 },
  { merchantId: "kaiser", merchant: "Kaiser Permanente", mcc: "8062", channel: "in_store", perYear: 5, low: 20, high: 40 },
];

/** Small deterministic PRNG so the synthetic year is identical on every run. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A labeled-synthetic year of Rosa's card activity, ending the day before `now`. */
export function seedHistory(now = new Date("2026-10-24T09:00:00-07:00")): Transaction[] {
  const rand = mulberry32(78);
  const out: Transaction[] = [];
  const dayMs = 86_400_000;
  for (const s of STORE_SEEDS) {
    for (let i = 0; i < s.perYear; i++) {
      const daysAgo = Math.floor(((i + rand()) / s.perYear) * 364) + 1;
      const t = new Date(now.getTime() - daysAgo * dayMs);
      t.setHours(9 + Math.floor(rand() * 8), Math.floor(rand() * 60), 0, 0);
      const amount = Math.round((s.low + (s.high - s.low) * Math.pow(rand(), 1.3)) * 100) / 100;
      out.push({
        id: `hist-${s.merchantId}-${i}`,
        simulated: true,
        merchant: s.merchant,
        merchantId: s.merchantId,
        mcc: s.mcc,
        category: MCC[s.mcc],
        amount,
        channel: s.channel,
        time: t.toISOString(),
        status: "approved",
        firedRuleIds: [],
        reason: "Within Rosa's usual pattern",
      });
    }
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

export function defaultRules(): SafetyRule[] {
  return [
    {
      id: "rule-big-purchase",
      kind: "single_purchase_checkin",
      title: "Check in with me on any purchase over $200",
      detail: "The payment waits while my helper asks me one quick question. If it was me, I can continue on my own.",
      vtcConcept: "Spend limit: alert / check-in threshold (per transaction)",
      action: "check_in",
      releaseBy: "rosa_self",
      enabled: true,
      params: { thresholdUsd: 200, channels: ["in_store", "online"] },
    },
    {
      id: "rule-unusual-store",
      kind: "merchant_anomaly_checkin",
      title: "Check in when a store charge is far above my usual",
      detail: "If I spend more than 4 times my usual high at a store (and over $75), my helper checks in first.",
      vtcConcept: "Merchant controls + history-based alert threshold",
      action: "check_in",
      releaseBy: "rosa_self",
      enabled: true,
      params: { multipleOfUsualMax: 4, minAmountUsd: 75 },
    },
    {
      id: "rule-funds-transfer",
      kind: "funds_transfer_block",
      title: "Always stop wires, money transfers, crypto and cash-like payments",
      detail: "These are stopped every time and Priya is told. Only Rosa and Priya together can change this.",
      vtcConcept: "Funds-transfer controls + MCC block (4829, 6051, 6540)",
      action: "block",
      releaseBy: "rosa_and_priya",
      enabled: true,
      params: { mccs: ["4829", "6051", "6540"] },
    },
    {
      id: "rule-scam-safety",
      kind: "scam_safety_block",
      title: "If a check-in sounds like a scam, keep the payment stopped and tell Priya",
      detail:
        "Rosa's choice. If my answer shows someone may be pressuring me, the payment stays blocked and Priya is alerted. Only Rosa and Priya together can unblock it.",
      vtcConcept: "Decline (hard) threshold triggered by a check-in result",
      action: "block",
      releaseBy: "rosa_and_priya",
      enabled: true,
      optIn: true,
      params: {},
    },
  ];
}

/** Library of known scam-script phrases (seeded into memory). Public-awareness style summaries. */
export const SCAM_SCRIPTS: { id: string; pattern: string; text: string }[] = [
  { id: "scam-ts-1", pattern: "tech_support_impersonation", text: "Caller says he is from Microsoft and your computer has a virus; asks you to buy gift cards to fix it." },
  { id: "scam-ts-2", pattern: "tech_support_impersonation", text: "Someone from Apple or Amazon support says your account was hacked and you must pay with gift cards or a store card right now." },
  { id: "scam-ts-3", pattern: "tech_support_impersonation", text: "A pop-up or caller from 'Windows support' wants remote access and then asks for payment by Google Play, Apple or Target gift cards." },
  { id: "scam-gov-1", pattern: "government_impersonation", text: "Caller claims to be from the IRS or Social Security, says you owe money or will be arrested, and tells you to pay with gift cards." },
  { id: "scam-gov-2", pattern: "government_impersonation", text: "Someone says they are from Medicare or the police and needs a payment today to avoid a penalty." },
  { id: "scam-bank-1", pattern: "bank_impersonation", text: "Caller says he is from your bank's fraud department and tells you to move money or buy cards to keep it safe." },
  { id: "scam-fam-1", pattern: "family_emergency", text: "A grandson or relative calls crying, says he is in jail or hurt, asks you to buy gift cards and not tell anyone." },
  { id: "scam-rom-1", pattern: "romance", text: "A new online friend or sweetheart asks you to buy gift cards or send money for an emergency or a plane ticket." },
  { id: "scam-prize-1", pattern: "prize_or_lottery", text: "You won a prize or lottery but must first pay fees with gift cards." },
  { id: "scam-util-1", pattern: "utility_shutoff", text: "Caller from the power or water company says service will be shut off in an hour unless you pay with gift cards." },
  { id: "scam-pressure-1", pattern: "phone_pressure_purchase", text: "Someone stays on the phone while you are at the store, tells you exactly what to buy, and says not to tell the cashier." },
  { id: "scam-pressure-2", pattern: "phone_pressure_purchase", text: "Caller tells you to read the numbers on the back of the cards to him over the phone." },
];

/** Operator scenarios. Card-side data only. */
export type ScenarioId = "grocery" | "cvs500" | "medical640" | "wire900";
export const SCENARIOS: Record<ScenarioId, { label: string; sub: string; auth: Omit<CardAuthorization, "time"> }> = {
  grocery: {
    label: "Groceries at Safeway",
    sub: "$46.18 · in store · normal",
    auth: { merchant: "Safeway", merchantId: "safeway", mcc: "5411", category: MCC["5411"], amount: 46.18, channel: "in_store" },
  },
  cvs500: {
    label: "$500 at CVS",
    sub: "$500.00 · in store · unusual",
    auth: { merchant: "CVS Pharmacy", merchantId: "cvs", mcc: "5912", category: MCC["5912"], amount: 500, channel: "in_store" },
  },
  medical640: {
    label: "$640 medical supply",
    sub: "$640.00 · in store · Rosa's walker",
    auth: { merchant: "Bay Mobility & Medical", merchantId: "baymobility", mcc: "5976", category: MCC["5976"], amount: 640, channel: "in_store" },
  },
  wire900: {
    label: "$900 money transfer",
    sub: "$900.00 · online · wire",
    auth: { merchant: "QuickWire Transfer", merchantId: "quickwire", mcc: "4829", category: MCC["4829"], amount: 900, channel: "online" },
  },
};

export const SCRIPTED_SCAM_ANSWER = "Yes, the Microsoft man told me to buy gift cards.";
export const SCRIPTED_GENUINE_ANSWER = "No, this was me. It's my new walker, the doctor ordered it.";
