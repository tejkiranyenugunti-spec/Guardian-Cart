// Shared types for GuardianCart. Used by the server, the web app and the tests.

export type Channel = "in_store" | "online";
export type TransactionType = "purchase" | "funds_transfer" | "quasi_cash" | "cash_withdrawal";

/**
 * A card transaction event as a card network would push it (e.g. a Visa Transaction Controls
 * notification). Card-side facts ONLY. Nothing about items in the basket.
 */
export interface TransactionEvent {
  transaction_id: string;
  card_id: string;
  merchant: string;
  merchant_category: string; // MCC, e.g. "5912"
  amount: number;
  currency: "USD";
  timestamp: string; // ISO 8601
  transaction_type: TransactionType;
  channel: Channel; // in_store | online
  source: "simulated" | "visa";
}

/**
 * What a card authorization realistically carries. NOTHING about items.
 * The card layer never knows what was in the basket (e.g. gift cards).
 */
export interface CardAuthorization {
  merchant: string;
  merchantId: string; // stable key used for history stats, e.g. "cvs"
  mcc: string; // merchant category code, e.g. "5912"
  category: string; // human label for the MCC, e.g. "Pharmacy"
  amount: number; // USD
  channel: Channel;
  time: string; // ISO timestamp
  transactionType?: TransactionType;
}

export type TxnStatus =
  | "approved" // normal, silent
  | "paused" // declined and held for a check-in
  | "blocked" // stopped by a hard rule (pre-agreed)
  | "released"; // a paused check-in that Rosa confirmed herself; retry will be approved

export interface Transaction extends CardAuthorization {
  id: string;
  simulated: true; // every transaction in this app is simulated
  source?: "simulated" | "visa";
  cardId?: string;
  status: TxnStatus;
  firedRuleIds: string[];
  reason: string; // plain-English reason from the policy engine
  checkInId?: string;
}

export type RuleKind =
  | "single_purchase_checkin" // VTC: spend limit (alert/check-in threshold)
  | "merchant_anomaly_checkin" // unusual for that merchant (history)
  | "funds_transfer_block" // VTC: funds transfer / quasi-cash / crypto MCC controls
  | "scam_safety_block"; // Rosa's explicit opt-in

export type ReleaseBy = "rosa_self" | "rosa_and_priya";

export interface SafetyRule {
  id: string;
  kind: RuleKind;
  title: string; // plain language for Rosa
  detail: string; // plain language detail
  vtcConcept: string; // Visa Transaction Controls vocabulary
  action: "check_in" | "block";
  releaseBy: ReleaseBy;
  enabled: boolean;
  optIn?: boolean; // requires Rosa's explicit opt-in during setup
  params: {
    thresholdUsd?: number;
    multipleOfUsualMax?: number;
    minAmountUsd?: number;
    mccs?: string[];
    channels?: Channel[];
  };
}

export interface RuleAgreement {
  proposedBy: "priya";
  rosaSignedAt?: string;
  priyaSignedAt?: string;
  scamSafetyOptIn: boolean; // Rosa's explicit choice
}

export interface MerchantStats {
  merchantId: string;
  merchant: string;
  category: string;
  count: number;
  median: number;
  p90: number;
  max: number;
  typicalLow: number;
  typicalHigh: number;
}

/** Output of the deterministic policy engine for a new authorization. */
export interface AuthorizationDecision {
  decision: "approve" | "pause" | "decline";
  status: TxnStatus;
  firedRuleIds: string[];
  reason: string;
  usual?: MerchantStats;
}

export type ScamRisk = "none" | "low" | "medium" | "high";
export type ScamPattern =
  | "tech_support_impersonation"
  | "government_impersonation"
  | "bank_impersonation"
  | "family_emergency"
  | "romance"
  | "prize_or_lottery"
  | "utility_shutoff"
  | "phone_pressure_purchase"
  | "none"
  | "unclear";
export type PaymentRequest = "gift_cards" | "wire_transfer" | "crypto" | "cash" | "none" | "unknown";

/**
 * The ONLY thing the AI is allowed to hand to the policy engine.
 * There is deliberately no field for "release", "approve" or "raise limit".
 */
export interface RiskSignal {
  scam_risk: ScamRisk;
  pattern: ScamPattern;
  payment_request: PaymentRequest;
  pressure_signals: string[];
  rosa_says_own_purchase: boolean; // Rosa said the purchase was hers (does NOT release anything)
  evidence_quote: string; // verbatim from Rosa's words
  source: "rosa_answer";
  detectors: string[]; // which detectors contributed: "claude", "phrase_rules", "memory"
}

export type CheckInPhase = "asking" | "thinking" | "awaiting_confirmation" | "resolved";
export type CheckInOutcome =
  | "blocked_scam" // likely scam + Rosa opted into the scam-safety rule -> hard block
  | "paused_concern" // scam signal but no hard block applies: stays paused, Rosa cannot self-release
  | "paused_unclear" // no scam signal yet; waits for Rosa's explicit "this was me"
  | "released_by_rosa"; // Rosa explicitly confirmed and the rule allows self-release

export interface TranscriptLine {
  id: string;
  speaker: "helper" | "rosa";
  text: string;
  via?: "voice" | "typed" | "quick_reply" | "system";
  at: string;
}

export interface MemoryHit {
  id: string;
  kind: string;
  text: string;
  score: number;
}

export interface CheckIn {
  id: string;
  txnId: string;
  phase: CheckInPhase;
  question: string;
  questionSource: "claude" | "template";
  transcript: TranscriptLine[];
  cardFacts: { label: string; value: string }[];
  rosaFacts: string[]; // short facts that came only from Rosa's words
  risk?: RiskSignal;
  riskSource?: "claude+rules" | "rules_only";
  outcome?: CheckInOutcome;
  outcomeHeadline?: string;
  memoryContext: MemoryHit[];
  aiReason?: string; // plain-language reason (Claude) shown to Priya
  indicators?: string[]; // scam indicators shown to Priya
  familyNotifiedAt?: string; // when Priya got the urgent alert
  rosaDismissedAt?: string; // Rosa closed the outcome screen
  scamMatches: MemoryHit[];
  priorIncidents: MemoryHit[];
  familySummary?: string;
  startedAt: string;
  resolvedAt?: string;
  working: { step: string; done: boolean }[];
}

export type TimelineActor = "card" | "rules" | "helper" | "rosa" | "priya" | "memory";
export interface TimelineEvent {
  id: string;
  at: string;
  actor: TimelineActor;
  text: string;
  checkInId?: string;
}

export interface FamilyAlert {
  id: string;
  level: "urgent" | "info";
  title: string;
  body: string;
  checkInId?: string;
  txnId?: string;
  at: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
}

export interface RuleEdit {
  thresholdUsd?: number;
  unusualStoreCheck?: boolean;
  scamSafety?: boolean;
}

export interface RuleChange {
  id: string;
  proposedBy: "rosa" | "priya";
  at: string;
  edit: RuleEdit;
  summary: string[]; // plain language, e.g. "Check in on purchases over $300 (was $200)"
  rosaAgreedAt?: string;
  priyaAgreedAt?: string;
  status: "pending" | "agreed" | "declined";
  declinedBy?: "rosa" | "priya";
  resolvedAt?: string;
}

export interface FamilyMessage {
  id: string;
  from: "rosa" | "priya";
  text: string;
  at: string;
  readAt?: string;
}

export type ServiceMode = "live" | "fallback" | "error";
export interface IntegrationStatus {
  claude: { mode: ServiceMode; detail: string; lastUsed?: "live" | "fallback" };
  cartesiaTts: { mode: ServiceMode; detail: string };
  cartesiaStt: { mode: ServiceMode; detail: string };
  moss: { mode: ServiceMode; detail: string; lastLatencyMs?: number };
  visa: { mode: "simulated"; detail: string };
}

export interface Profile {
  name: string;
  age: number;
  city: string;
  preferredName: string;
  speechPreference: string;
  trustedContact: { name: string; relation: string; phoneLabel: string };
  preferredStores: { merchantId: string; name: string; category: string; note: string }[];
  recurringItems: string[];
}

export interface AppState {
  version: number;
  household: string; // "home" (the real app) or "stage" (presentation)
  demoMode: boolean;
  provider: { name: string; kind: "simulated" | "visa"; cardId: string; cardLabel: string };
  ruleChanges: RuleChange[]; // newest first; at most one pending
  messages: FamilyMessage[]; // newest first
  profile: Profile;
  rules: SafetyRule[];
  agreement: RuleAgreement;
  history: Transaction[]; // seeded synthetic year (most recent first, trimmed for the wire)
  historyCount: number;
  stats: MerchantStats[];
  transactions: Transaction[]; // live demo transactions, most recent first
  checkIns: CheckIn[];
  activeCheckInId?: string;
  alerts: FamilyAlert[];
  timeline: TimelineEvent[];
  integrations: IntegrationStatus;
  callMom?: { at: string; status: "calling" | "ended" };
  rosaNotice?: { id: string; title: string; body: string; spoken: string; txnId: string; at: string };
}
