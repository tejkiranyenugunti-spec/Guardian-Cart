// The GuardianCart service for one household. The real app ("home") and the presentation
// ("stage") each get their own instance, with the SAME logic and separate, persisted data.
// Card event -> deterministic policy -> automatic check-in -> Rosa answers -> AI risk analysis
// -> deterministic policy decides -> state change -> Priya's screen (SSE) -> persisted.
import { randomUUID } from "node:crypto";
import { PROFILE, SCENARIOS, defaultRules, seedHistory, type ScenarioId } from "../shared/data";
import {
  applyRiskSignal,
  combineRisk,
  computeStats,
  evaluateAuthorization,
  isScamFlag,
  money,
  releaseByRosa,
  roughMoney,
  rulesAgreed,
} from "../shared/policy";
import { classifyAnswer, rosaFactsFrom } from "../shared/classifier";
import type {
  AppState,
  CardAuthorization,
  CheckIn,
  CheckInOutcome,
  FamilyAlert,
  MemoryHit,
  RiskSignal,
  RuleChange,
  RuleEdit,
  SafetyRule,
  TimelineActor,
  Transaction,
  TransactionEvent,
  TranscriptLine,
} from "../shared/types";
import { assessAnswer, shortMerchant, validRosaReason, writeQuestion } from "./agent";
import { buildSeedDocs, Memory, type MemoryDoc } from "./memory";
import { hasCartesia, hasClaude, CONFIG } from "./config";
import { mccLabel, merchantKey, type AuthorizationResponse } from "./transactions";
import { MemoryStore, type StateStore } from "./store";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Persisted {
  schema: 2;
  state: AppState;
  memoryWrites: MemoryDoc[];
}

const nowIso = () => new Date().toISOString();
const id = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stepMs = () => Number(process.env.GUARDIANCART_STEP_MS ?? 450);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const THRESHOLDS = [100, 150, 200, 250, 300, 400, 500];

const PATTERN_PHRASE: Record<string, string> = {
  tech_support_impersonation: "a caller claiming to be tech support",
  government_impersonation: "a caller claiming to be from the government",
  bank_impersonation: "a caller claiming to be from her bank",
  family_emergency: "a caller claiming a relative is in trouble",
  romance: "an online friend asking for money",
  prize_or_lottery: "a caller promising a prize",
  utility_shutoff: "a caller threatening to shut off a utility",
  phone_pressure_purchase: "someone on the phone telling her what to buy",
};

export interface GuardianOptions {
  household: string;
  cardId: string;
  cardLabel: string;
  demoMode: boolean;
  store?: StateStore<Persisted>;
  providerName?: string;
}

export class Guardian {
  state!: AppState;
  readonly household: string;
  private fullHistory: Transaction[] = [];
  private listeners = new Set<(s: AppState) => void>();
  private busy = false;
  private work: Promise<unknown>[] = [];
  private store: StateStore<Persisted>;

  constructor(
    public memory: Memory,
    private opts: GuardianOptions = { household: "test", cardId: "card-test", cardLabel: "Visa •••• 0000", demoMode: true },
  ) {
    this.household = opts.household;
    this.store = opts.store ?? new MemoryStore<Persisted>();
  }

  /** Load persisted state if any, else start fresh (setup not yet agreed). */
  async init() {
    this.fullHistory = seedHistory();
    const saved = this.store.load();
    if (saved?.schema === 2 && saved.state) {
      this.state = this.freshState();
      Object.assign(this.state, saved.state, { integrations: this.state.integrations, version: saved.state.version + 1 });
      this.recoverAfterRestart();
      await this.memory.init(buildSeedDocs(this.statsNow(), this.state.rules, this.fullHistory), saved.memoryWrites ?? []);
      this.emit();
      return;
    }
    await this.reset({ keepAgreement: false, reseedMemory: true });
  }

  /** Wait for background work (question composition) to finish. Used by tests and the CLI. */
  async idle() {
    while (this.work.length) await Promise.allSettled(this.work.splice(0));
  }

  flush() {
    this.store.flush();
  }

  // ---------------------------------------------------------------- state plumbing
  subscribe(fn: (s: AppState) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): AppState {
    return this.state;
  }

  private emit() {
    this.state.version++;
    this.state.activeCheckInId = this.computeActiveCheckIn();
    this.state.stats = this.statsNow();
    this.refreshIntegrations();
    // Integration status is recomputed at startup and never persisted (no config or secrets on disk).
    const { integrations: _omit, ...persistable } = this.state;
    this.store.save({ schema: 2, state: { ...persistable, history: [] } as unknown as AppState, memoryWrites: this.memory.writes });
    for (const l of this.listeners) l(this.state);
  }

  /** Rosa sees the oldest open check-in first; afterwards, the latest outcome until she closes it. */
  private computeActiveCheckIn() {
    // checkIns is newest-first, so the last open one in the list is the oldest.
    const oldestOpen = [...this.state.checkIns].reverse().find((c) => c.phase !== "resolved");
    if (oldestOpen) return oldestOpen.id;
    return this.state.checkIns.find((c) => c.phase === "resolved" && !c.rosaDismissedAt)?.id;
  }

  private statsNow() {
    const live = (this.state?.transactions ?? []).filter((t) => t.status === "approved" || t.status === "released");
    return computeStats([...this.fullHistory, ...live]);
  }

  private recoverAfterRestart() {
    // A check-in that was mid-analysis when the server stopped goes back to waiting for Rosa.
    for (const c of this.state.checkIns) {
      if (c.phase === "thinking") {
        c.phase = c.risk ? "awaiting_confirmation" : "asking";
        c.working = [];
      }
      if (!c.question && c.phase === "asking") {
        const t = this.state.transactions.find((x) => x.id === c.txnId);
        if (t) c.question = `Rosa, your card was just used for ${money(t.amount)} at ${shortMerchant(t.merchant)}. Is someone on the phone asking you to buy something?`;
        c.transcript.push(this.line("helper", c.question, "system"));
      }
    }
    if (this.state.callMom?.status === "calling") this.state.callMom = { at: nowIso(), status: "ended" };
    this.state.history = this.fullHistory.slice(0, 14);
  }

  private log(actor: TimelineActor, text: string, checkInId?: string) {
    this.state.timeline.unshift({ id: id("t"), at: nowIso(), actor, text, checkInId });
    this.state.timeline = this.state.timeline.slice(0, 200);
  }

  private alert(a: Omit<FamilyAlert, "id" | "at" | "acknowledged">) {
    // A newer alert about the same check-in replaces the earlier "checking in" note.
    if (a.checkInId) this.state.alerts = this.state.alerts.filter((x) => x.checkInId !== a.checkInId);
    this.state.alerts.unshift({ ...a, id: id("alert"), at: nowIso(), acknowledged: false });
  }

  private refreshIntegrations() {
    const s = this.state.integrations;
    s.claude.mode = hasClaude() ? "live" : "fallback";
    s.claude.detail = hasClaude()
      ? `Claude ${CONFIG.anthropic.fastModel} (question) + ${CONFIG.anthropic.reasoningModel} (risk analysis)`
      : "Not configured: deterministic classifier + templates";
    s.cartesiaTts = hasCartesia()
      ? { mode: "live", detail: `Cartesia ${CONFIG.cartesia.ttsModel}, speed ${CONFIG.cartesia.speed}` }
      : { mode: "fallback", detail: "Not configured: browser speech + captions" };
    s.cartesiaStt = hasCartesia()
      ? { mode: "live", detail: `Cartesia ${CONFIG.cartesia.sttModel} (push-to-talk)` }
      : { mode: "fallback", detail: "Not configured: browser speech recognition or typed answer" };
    s.moss = { mode: this.memory.mode, detail: this.memory.detail, lastLatencyMs: this.memory.lastLatencyMs };
  }

  get activeCheckIn(): CheckIn | undefined {
    return this.state.checkIns.find((c) => c.id === this.state.activeCheckInId);
  }

  private openCheckIn(checkInId?: string): CheckIn {
    const ci = checkInId ? this.state.checkIns.find((c) => c.id === checkInId) : this.state.checkIns.find((c) => c.id === this.computeActiveCheckIn());
    if (!ci) throw new HttpError(409, "There is no check-in right now.");
    return ci;
  }

  private txn(idv: string) {
    const t = this.state.transactions.find((x) => x.id === idv);
    if (!t) throw new HttpError(404, "Transaction not found");
    return t;
  }

  private freshState(): AppState {
    return {
      version: (this.state?.version ?? 0) + 1,
      household: this.household,
      demoMode: this.opts.demoMode,
      provider: { name: this.opts.providerName ?? "Simulated card network", kind: "simulated", cardId: this.opts.cardId, cardLabel: this.opts.cardLabel },
      profile: PROFILE,
      rules: defaultRules(),
      agreement: { proposedBy: "priya", scamSafetyOptIn: false },
      ruleChanges: [],
      messages: [],
      history: this.fullHistory.slice(0, 14),
      historyCount: this.fullHistory.length,
      stats: computeStats(this.fullHistory),
      transactions: [],
      checkIns: [],
      alerts: [],
      timeline: [],
      integrations: {
        claude: { mode: "fallback", detail: "" },
        cartesiaTts: { mode: "fallback", detail: "" },
        cartesiaStt: { mode: "fallback", detail: "" },
        moss: { mode: "fallback", detail: "" },
        visa: { mode: "simulated", detail: "SIMULATED card network (SimulatedTransactionProvider). No real Visa API; RealVisaTransactionProvider is a placeholder." },
      },
    };
  }

  // ---------------------------------------------------------------- reset / setup
  async reset(opts: { keepAgreement: boolean; reseedMemory?: boolean }) {
    const prev = this.state;
    this.fullHistory = seedHistory();
    this.state = this.freshState();
    if (opts.keepAgreement && prev && rulesAgreed(prev.agreement)) {
      this.state.rules = prev.rules;
      this.state.agreement = prev.agreement;
    }
    if (opts.reseedMemory || !prev) await this.memory.init(buildSeedDocs(this.statsNow(), this.state.rules, this.fullHistory));
    else await this.memory.forgetDemoWrites();
    if (rulesAgreed(this.state.agreement)) this.log("rules", "Activity cleared. Rosa and Priya's agreed rules are still in place.");
    this.busy = false;
    this.emit();
  }

  setScamOptIn(optIn: boolean) {
    this.editRules("rosa", { scamSafety: optIn });
  }

  sign(who: "rosa" | "priya") {
    const a = this.state.agreement;
    if (who === "rosa") {
      if (a.rosaSignedAt) return this.state;
      a.rosaSignedAt = nowIso();
      this.log("rosa", a.scamSafetyOptIn ? "Rosa agreed to the safety rules and turned on the scam-safety rule herself." : "Rosa agreed to the safety rules (scam-safety rule left off).");
    } else {
      if (a.priyaSignedAt) return this.state;
      a.priyaSignedAt = nowIso();
      this.log("priya", "Priya agreed to the safety rules.");
    }
    if (rulesAgreed(a)) this.log("rules", "Rules are now active: agreed by Rosa and Priya.");
    this.emit();
    return this.state;
  }

  // ---------------------------------------------------------------- rule changes (both must agree)
  private describeEdit(edit: RuleEdit): string[] {
    const out: string[] = [];
    const big = this.state.rules.find((r) => r.kind === "single_purchase_checkin");
    const store = this.state.rules.find((r) => r.kind === "merchant_anomaly_checkin");
    if (edit.thresholdUsd !== undefined && edit.thresholdUsd !== big?.params.thresholdUsd)
      out.push(`Check in on purchases over ${roughMoney(edit.thresholdUsd)} (was ${roughMoney(big?.params.thresholdUsd ?? 0)})`);
    if (edit.unusualStoreCheck !== undefined && edit.unusualStoreCheck !== store?.enabled)
      out.push(edit.unusualStoreCheck ? "Turn ON: check in when a store charge is far above usual" : "Turn OFF: check in when a store charge is far above usual");
    if (edit.scamSafety !== undefined && edit.scamSafety !== this.state.agreement.scamSafetyOptIn)
      out.push(edit.scamSafety ? "Turn ON the scam-safety rule (keep a payment stopped if a check-in sounds like a scam)" : "Turn OFF the scam-safety rule");
    return out;
  }

  private applyEdit(edit: RuleEdit) {
    for (const r of this.state.rules) {
      if (r.kind === "single_purchase_checkin" && edit.thresholdUsd !== undefined) {
        r.params.thresholdUsd = edit.thresholdUsd;
        r.title = `Check in with me on any purchase over ${roughMoney(edit.thresholdUsd)}`;
      }
      if (r.kind === "merchant_anomaly_checkin" && edit.unusualStoreCheck !== undefined) r.enabled = edit.unusualStoreCheck;
    }
    if (edit.scamSafety !== undefined) this.state.agreement.scamSafetyOptIn = edit.scamSafety;
  }

  private validateEdit(edit: RuleEdit): RuleEdit {
    const out: RuleEdit = {};
    if (edit.thresholdUsd !== undefined) {
      const t = Number(edit.thresholdUsd);
      if (!THRESHOLDS.includes(t)) throw new HttpError(400, `Check-in amount must be one of ${THRESHOLDS.map((x) => `$${x}`).join(", ")}`);
      out.thresholdUsd = t;
    }
    if (edit.unusualStoreCheck !== undefined) out.unusualStoreCheck = Boolean(edit.unusualStoreCheck);
    if (edit.scamSafety !== undefined) out.scamSafety = Boolean(edit.scamSafety);
    return out;
  }

  /**
   * Before both have agreed: edits change the draft directly, and the other person must agree again.
   * After: edits become a proposal that only takes effect when the other person agrees too.
   * The scam-safety rule is Rosa's choice during setup.
   */
  editRules(who: "rosa" | "priya", rawEdit: RuleEdit) {
    const edit = this.validateEdit(rawEdit);
    const summary = this.describeEdit(edit);
    if (!summary.length) return { ok: true, pending: false };
    const a = this.state.agreement;
    if (!rulesAgreed(a)) {
      if (edit.scamSafety !== undefined && who !== "rosa") throw new HttpError(403, "The scam-safety rule is Rosa's choice. Priya can suggest it after setup.");
      if (who === "rosa" && a.rosaSignedAt && edit.scamSafety !== undefined && Object.keys(edit).length === 1)
        throw new HttpError(409, "Rosa already signed. Changing a rule now needs both Rosa and Priya.");
      this.applyEdit(edit);
      const other = who === "rosa" ? "priyaSignedAt" : "rosaSignedAt";
      const mine = who === "rosa" ? "rosaSignedAt" : "priyaSignedAt";
      if (a[other] && Object.keys(edit).some((k) => k !== "scamSafety")) {
        a[other] = undefined;
        this.log(who, `${who === "rosa" ? "Rosa" : "Priya"} changed the proposed rules (${summary.join("; ")}). ${who === "rosa" ? "Priya" : "Rosa"} needs to agree again.`);
      } else if (Object.keys(edit).some((k) => k !== "scamSafety")) {
        this.log(who, `${who === "rosa" ? "Rosa" : "Priya"} changed the proposed rules: ${summary.join("; ")}.`);
      }
      if (a[mine] && Object.keys(edit).some((k) => k !== "scamSafety")) a[mine] = undefined;
      this.emit();
      return { ok: true, pending: false };
    }
    if (this.state.ruleChanges.some((c) => c.status === "pending")) throw new HttpError(409, "There is already a change waiting for an answer.");
    const change: RuleChange = {
      id: id("change"),
      proposedBy: who,
      at: nowIso(),
      edit,
      summary,
      status: "pending",
      ...(who === "rosa" ? { rosaAgreedAt: nowIso() } : { priyaAgreedAt: nowIso() }),
    };
    this.state.ruleChanges.unshift(change);
    this.log(who, `${who === "rosa" ? "Rosa" : "Priya"} suggested a rule change: ${summary.join("; ")}. Waiting for ${who === "rosa" ? "Priya" : "Rosa"}.`);
    this.emit();
    return { ok: true, pending: true, changeId: change.id };
  }

  respondToChange(who: "rosa" | "priya", changeId: string, accept: boolean) {
    const c = this.state.ruleChanges.find((x) => x.id === changeId);
    if (!c || c.status !== "pending") throw new HttpError(409, "That change is no longer waiting for an answer.");
    if (c.proposedBy === who) {
      if (!accept) {
        c.status = "declined";
        c.declinedBy = who;
        c.resolvedAt = nowIso();
        this.log(who, `${who === "rosa" ? "Rosa" : "Priya"} withdrew the suggested change.`);
        this.emit();
        return c;
      }
      throw new HttpError(409, "The other person needs to agree to this change.");
    }
    c.resolvedAt = nowIso();
    if (!accept) {
      c.status = "declined";
      c.declinedBy = who;
      this.log(who, `${who === "rosa" ? "Rosa" : "Priya"} said no to the suggested change. The rules stay the same.`);
    } else {
      if (who === "rosa") c.rosaAgreedAt = nowIso();
      else c.priyaAgreedAt = nowIso();
      c.status = "agreed";
      this.applyEdit(c.edit);
      this.log("rules", `Rule change agreed by Rosa and Priya: ${c.summary.join("; ")}.`);
    }
    this.emit();
    return c;
  }

  // ---------------------------------------------------------------- card events
  /** Stage scenarios go through the same pipeline as any other card event. */
  scenarioEvent(scenario: ScenarioId) {
    const sc = SCENARIOS[scenario];
    if (!sc) throw new HttpError(400, "Unknown scenario");
    const transfer = sc.auth.mcc === "4829";
    return {
      merchant: sc.auth.merchant,
      merchant_category: sc.auth.mcc,
      amount: sc.auth.amount,
      channel: sc.auth.channel,
      transaction_type: transfer ? "funds_transfer" : "purchase",
      card_id: this.opts.cardId,
    };
  }

  /**
   * The automatic pipeline entry point. Returns the authorization decision right away;
   * a paused payment starts Rosa's check-in in the background (no button needed).
   */
  async ingest(ev: TransactionEvent): Promise<AuthorizationResponse> {
    const existing = this.state.transactions.find((t) => t.id === ev.transaction_id);
    if (existing) {
      return { transaction_id: ev.transaction_id, decision: existing.status === "approved" || existing.status === "released" ? "approve" : "decline", status: "duplicate", reason: "Already processed", household: this.household };
    }
    const known = this.fullHistory.find((t) => norm(t.merchant) === norm(ev.merchant) || norm(t.merchant).startsWith(norm(ev.merchant)));
    const auth: CardAuthorization = {
      merchant: known?.merchant ?? ev.merchant,
      merchantId: known?.merchantId ?? merchantKey(ev.merchant),
      mcc: ev.merchant_category,
      category: mccLabel(ev.merchant_category),
      amount: ev.amount,
      channel: ev.channel,
      time: ev.timestamp,
      transactionType: ev.transaction_type,
    };
    const d = evaluateAuthorization(auth, this.state.rules, this.state.agreement, this.state.stats);
    const txn: Transaction = { ...auth, id: ev.transaction_id, simulated: true, source: ev.source, cardId: ev.card_id, status: d.status, firedRuleIds: d.firedRuleIds, reason: d.reason };
    this.state.transactions.unshift(txn);
    this.state.transactions = this.state.transactions.slice(0, 300);
    this.log("card", `SIMULATED card payment: ${auth.merchant} · ${auth.category} · ${money(auth.amount)} · ${auth.channel === "in_store" ? "in store" : "online"}`);
    const response = (status: Transaction["status"]): AuthorizationResponse => ({
      transaction_id: txn.id,
      decision: status === "approved" ? "approve" : "decline",
      status,
      reason: d.reason,
      household: this.household,
    });

    if (d.status === "approved") {
      this.log("rules", rulesAgreed(this.state.agreement) ? "Within Rosa's usual pattern. Approved. Nobody was interrupted." : "Approved (no safety rules agreed yet).");
      this.emit();
      return response("approved");
    }

    const ruleTitles = this.state.rules.filter((r) => d.firedRuleIds.includes(r.id)).map((r) => `"${r.title}"`);
    if (d.status === "blocked") {
      this.log("rules", `Stopped by an agreed rule: ${ruleTitles.join(", ")}.`);
      const spoken = `Rosa, your card just stopped a ${money(auth.amount)} money transfer, as you and Priya agreed. If someone is asking you to send money, please hang up. I've let Priya know.`;
      this.state.rosaNotice = { id: id("notice"), title: `${money(auth.amount)} transfer stopped`, body: spoken, spoken, txnId: txn.id, at: nowIso() };
      this.alert({
        level: "urgent",
        title: `${money(auth.amount)} money transfer stopped`,
        body: `A SIMULATED ${money(auth.amount)} payment to ${auth.merchant} was stopped by the rule "${this.state.rules.find((r) => r.id === d.firedRuleIds[0])?.title}". Mom was told to hang up if anyone is asking her to send money.`,
        txnId: txn.id,
      });
      this.log("priya", "Priya was alerted.");
      this.emit();
      return response("blocked");
    }

    // Paused: start Rosa's check-in automatically.
    const ci: CheckIn = {
      id: id("ci"),
      txnId: txn.id,
      phase: "asking",
      question: "",
      questionSource: "template",
      transcript: [],
      cardFacts: [
        { label: "Store", value: auth.merchant },
        { label: "Category", value: `${auth.category} (MCC ${auth.mcc})` },
        { label: "Amount", value: money(auth.amount) },
        { label: "Where", value: auth.channel === "in_store" ? "In store" : "Online" },
        { label: "Time", value: new Date(auth.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) },
        { label: "Rule", value: ruleTitles.map((t) => t.replace(/"/g, "")).join(" + ") },
      ],
      rosaFacts: [],
      memoryContext: [],
      scamMatches: [],
      priorIncidents: [],
      startedAt: nowIso(),
      working: [],
    };
    txn.checkInId = ci.id;
    const cardEvent = this.state.timeline.find((e) => e.actor === "card");
    if (cardEvent) cardEvent.checkInId = ci.id;
    this.state.checkIns.unshift(ci);
    this.log("rules", `Paused for a check-in: ${d.reason.replace(/^Paused for a quick check-in because /, "")}`, ci.id);
    // Informational only. No emergency alert while the payment is merely paused.
    this.alert({
      level: "info",
      title: `Checking in with Mom about ${money(auth.amount)} at ${shortMerchant(auth.merchant)}`,
      body: "No action needed. You'll hear back only if something is wrong.",
      checkInId: ci.id,
      txnId: txn.id,
    });
    this.emit();
    const job = this.composeQuestion(ci, auth, d.usual?.median).catch((e) => console.error("[guardian] question failed", e));
    this.work.push(job);
    return response("paused");
  }

  private async composeQuestion(ci: CheckIn, auth: CardAuthorization, usualMedian?: number) {
    const usualMem = (await this.memory.recall(`Rosa's usual spending at ${auth.merchant} ${auth.category}`, "store_pattern", 1, { merchantId: auth.merchantId }))[0];
    const recentHere = await this.memory.recall(`${auth.merchant} purchase`, "purchase", 3, { merchantId: auth.merchantId });
    const prior = (await this.memory.recall(`${auth.category} check-in caller asked Rosa to buy`, "incident", 3)).filter((m) => m.score > 0 && /RECALL:/.test(m.text)).slice(0, 1);
    ci.memoryContext = [usualMem, ...recentHere, ...prior].filter(Boolean) as MemoryHit[];
    ci.priorIncidents = prior;
    if (usualMem) this.log("memory", `Recalled: ${usualMem.text}`, ci.id);
    if (prior[0]) this.log("memory", `Recalled an earlier check-in: ${prior[0].text}`, ci.id);

    const q = await writeQuestion(auth, usualMem, usualMedian);
    if (q.error) console.warn("[agent] question fallback:", q.error);
    this.state.integrations.claude.lastUsed = q.source === "claude" ? "live" : "fallback";
    let question = q.text;
    const priorLine = prior[0]?.text.match(/RECALL: (.*)$/)?.[1];
    if (priorLine) question = question.replace(/ Is someone on the phone/, ` ${priorLine} Is someone on the phone`);
    ci.question = question;
    ci.questionSource = q.source;
    ci.transcript.push(this.line("helper", question, "system"));
    this.log("helper", `Asked Rosa: "${question}"`, ci.id);
    this.emit();
  }

  private line(speaker: "helper" | "rosa", text: string, via: TranscriptLine["via"]): TranscriptLine {
    return { id: id("l"), speaker, text, via, at: nowIso() };
  }

  // ---------------------------------------------------------------- Rosa answers
  async answer(raw: string, via: "voice" | "typed" | "quick_reply", checkInId?: string) {
    const text = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!text) throw new HttpError(400, "Please say or type an answer.");
    if (text.length > 500) throw new HttpError(400, "That answer is too long. Please keep it short.");
    const ci = this.openCheckIn(checkInId);
    if (!ci.question) throw new HttpError(409, "One moment, the question is still being prepared.");
    if (ci.phase !== "asking" && ci.phase !== "awaiting_confirmation") throw new HttpError(409, "This check-in is already finished.");
    if (this.busy) throw new HttpError(409, "Still thinking about the last answer.");
    this.busy = true;
    try {
      const txn = this.txn(ci.txnId);
      ci.transcript.push(this.line("rosa", text, via));
      ci.phase = "thinking";
      ci.working = [
        { step: "Understanding what you said", done: false },
        { step: "Comparing with scam calls I know about", done: false },
        { step: "Checking the rules you and Priya agreed on", done: false },
      ];
      this.log("rosa", `Rosa answered (${via === "voice" ? "by voice" : via === "typed" ? "typed" : "tapped"}): "${text}"`, ci.id);
      this.emit();

      const auth: CardAuthorization = txn;
      const rosaWordsAll = ci.transcript.filter((l) => l.speaker === "rosa").map((l) => l.text).join(" ");

      // 1. Deterministic classifier + memory (fast).
      const rulesSignal = classifyAnswer(text);
      const [scamMatches, priorIncidents, usualMem] = await Promise.all([
        this.memory.recall(text, "scam_script", 3),
        this.memory.recall(text, "incident", 2),
        this.memory.recall(`Rosa's usual spending at ${auth.merchant}`, "store_pattern", 1, { merchantId: auth.merchantId }),
      ]);
      ci.scamMatches = scamMatches.filter((m) => m.score > 0);
      ci.priorIncidents = priorIncidents.filter((m) => m.score > 0);
      await sleep(stepMs());
      ci.working[0].done = true;
      this.emit();

      // 2. Claude analyzes the conversation (structured risk signal). It cannot decide anything.
      const firedRuleTitles = this.state.rules.filter((r) => txn.firedRuleIds.includes(r.id)).map((r) => r.title);
      const claude = await assessAnswer({ auth, firedRuleTitles, transcript: ci.transcript, latestAnswer: text, usualMemory: usualMem[0], scamMatches: ci.scamMatches, priorIncidents: ci.priorIncidents });
      if (claude.error) console.warn("[agent] risk via rules only:", claude.error);
      this.state.integrations.claude.lastUsed = claude.signal ? "live" : "fallback";
      ci.working[1].done = true;
      this.emit();

      // Risk can only go up within a check-in: previous signal + rules + Claude.
      let combined: RiskSignal = combineRisk(ci.risk, rulesSignal, claude.signal);
      if (isScamFlag(combined) && ci.scamMatches.length) combined = { ...combined, detectors: [...new Set([...combined.detectors, "memory"])] };
      combined.evidence_quote = combined.evidence_quote && rosaWordsAll.toLowerCase().includes(combined.evidence_quote.toLowerCase()) ? combined.evidence_quote : text;
      ci.risk = combined;
      ci.riskSource = claude.signal ? "claude+rules" : "rules_only";
      ci.rosaFacts = rosaFactsFrom(combined);
      ci.indicators = combined.pressure_signals;
      ci.aiReason = claude.reason;
      if (ci.scamMatches[0] && isScamFlag(combined)) this.log("memory", `Matched a known scam script: ${ci.scamMatches[0].text.replace(/^Known scam script \([^)]*\): /, "")}`, ci.id);
      this.log(
        "helper",
        `Risk analysis: ${combined.scam_risk.toUpperCase()}${combined.pattern !== "none" && combined.pattern !== "unclear" ? ` · ${combined.pattern.replace(/_/g, " ")}` : ""}${combined.payment_request !== "none" && combined.payment_request !== "unknown" ? ` · asked for ${combined.payment_request.replace(/_/g, " ")}` : ""} (from Rosa's answer; ${ci.riskSource === "claude+rules" ? "Claude + phrase rules" : "phrase rules"})`,
        ci.id,
      );

      // 3. Deterministic policy decides; the application performs the state change.
      const decision = applyRiskSignal(txn, combined, this.state.rules, this.state.agreement);
      await sleep(stepMs());
      ci.working[2].done = true;
      txn.status = decision.status;
      txn.firedRuleIds = [...new Set([...txn.firedRuleIds, ...decision.addedRuleIds])];
      ci.outcome = decision.outcome;

      const reply = this.replyFor(decision.outcome, txn, combined, validRosaReason(claude.reason) ? claude.reason : undefined);
      ci.transcript.push(this.line("helper", reply, "system"));
      ci.outcomeHeadline = this.headlineFor(decision.outcome, txn);

      if (decision.outcome === "blocked_scam" || decision.outcome === "paused_concern") {
        ci.phase = "resolved";
        ci.resolvedAt = nowIso();
        this.log("rules", decision.outcome === "blocked_scam" ? `Rosa's scam-safety rule applied: ${money(txn.amount)} payment BLOCKED. Only Rosa and Priya together can change it.` : `Payment stays PAUSED and can't be continued alone (${decision.explanation})`, ci.id);
        this.log("helper", "Told Rosa: don't buy anything, hang up the phone.", ci.id);
        ci.familySummary = claude.familySummary ?? this.familySummaryTemplate(txn, combined);
        this.alert({
          level: "urgent",
          title: "Likely scam call. Mom was told to hang up.",
          body: `${money(txn.amount)} at ${shortMerchant(txn.merchant)} ${decision.outcome === "blocked_scam" ? "was stopped" : "is on hold"}. Mom says ${/micro ?soft/i.test(combined.evidence_quote) ? "a caller claiming to be from Microsoft" : (PATTERN_PHRASE[combined.pattern] ?? "someone")}${combined.payment_request === "gift_cards" ? " told her to buy gift cards" : combined.payment_request !== "none" && combined.payment_request !== "unknown" ? ` asked her to pay by ${combined.payment_request.replace(/_/g, " ")}` : " is directing the purchase"}.`,
          checkInId: ci.id,
          txnId: txn.id,
        });
        ci.familyNotifiedAt = nowIso();
        this.log("priya", "Priya received an urgent alert with the conversation.", ci.id);
        await this.rememberIncident(ci, txn, combined, decision.outcome);
      } else {
        ci.phase = "awaiting_confirmation";
        this.log("helper", combined.rosa_says_own_purchase ? "No scam signs. Waiting for Rosa to confirm it was her." : "Answer was unclear. Payment stays paused until Rosa confirms.", ci.id);
      }
      this.emit();
      return ci;
    } catch (e) {
      // Never leave a check-in stuck in "thinking".
      if (ci.phase === "thinking") {
        ci.phase = ci.risk ? "awaiting_confirmation" : "asking";
        ci.working = [];
        this.emit();
      }
      throw e;
    } finally {
      this.busy = false;
    }
  }

  private replyFor(outcome: CheckInOutcome, txn: Transaction, s: RiskSignal, aiReason?: string) {
    const amt = money(txn.amount);
    const why =
      aiReason ??
      (s.payment_request === "gift_cards"
        ? "Real companies never ask to be paid in gift cards."
        : s.pattern === "tech_support_impersonation"
          ? "Real tech companies never call you to ask for payment."
          : s.pattern === "government_impersonation"
            ? "Government offices never ask for payment over the phone like this."
            : "Nobody honest will pressure you to pay on the phone.");
    // Payment-status sentences are fixed code, never model text.
    switch (outcome) {
      case "blocked_scam":
        return `Thank you for telling me, Rosa. That is a scam. ${why} Please don't buy anything, and hang up the phone now. The ${amt} payment did not go through, and I've let Priya know.`;
      case "paused_concern":
        return `Thank you for telling me, Rosa. This sounds like it could be a scam. ${why} Please don't buy anything, and hang up the phone. The ${amt} payment is on hold, and I've let Priya know so she can call you.`;
      case "paused_unclear":
        return s.rosa_says_own_purchase
          ? `Thank you, Rosa. If this was you, tap "Yes, this was me" and you can use your card again for this purchase.`
          : `Thank you, Rosa. If someone on the phone is telling you what to buy, please hang up. If this purchase is your own, tap "Yes, this was me".`;
      case "released_by_rosa":
        return `All set, Rosa. You can use your card again at ${shortMerchant(txn.merchant)}. Thank you for checking with me.`;
    }
  }

  private headlineFor(outcome: CheckInOutcome, txn: Transaction) {
    const amt = money(txn.amount);
    switch (outcome) {
      case "blocked_scam":
        return `${amt} payment stopped. Rosa was told to hang up. Priya notified.`;
      case "paused_concern":
        return `${amt} payment on hold. Rosa was told to hang up. Priya notified.`;
      case "paused_unclear":
        return `${amt} payment waiting for Rosa to confirm.`;
      case "released_by_rosa":
        return `Rosa confirmed the ${amt} purchase herself.`;
    }
  }

  private familySummaryTemplate(txn: Transaction, s: RiskSignal) {
    const cat = txn.merchant.toLowerCase().includes(txn.category.toLowerCase()) ? "" : ` (${txn.category.toLowerCase()})`;
    return `The card showed a ${money(txn.amount)} ${txn.channel === "in_store" ? "in-store" : "online"} payment at ${txn.merchant}${cat}, far above her usual there. When asked, Mom said: "${s.evidence_quote}"`;
  }

  private async rememberIncident(ci: CheckIn, txn: Transaction, s: RiskSignal, outcome: CheckInOutcome) {
    const caller = s.pattern === "tech_support_impersonation" && /micro ?soft/i.test(s.evidence_quote) ? "a caller who said he was from Microsoft" : PATTERN_PHRASE[s.pattern] ?? "someone on the phone";
    const ask = s.payment_request === "gift_cards" ? "asked you to buy gift cards" : "pressured you to pay";
    const date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
    await this.memory.remember({
      id: `incident-${ci.id}`,
      kind: "incident",
      meta: { pattern: s.pattern, outcome },
      text: `Earlier check-in on ${date}: during a ${money(txn.amount)} ${txn.category.toLowerCase()} payment at ${txn.merchant}, Rosa said "${s.evidence_quote}". Outcome: ${outcome === "blocked_scam" ? "blocked by Rosa's scam-safety rule" : "held"}; Rosa was told to hang up; Priya was alerted. RECALL: Last time, ${caller} ${ask}.`,
    });
    this.log("memory", "Saved this check-in to Rosa's memory so future check-ins remember it.", ci.id);
    this.emit();
  }

  // ---------------------------------------------------------------- release path
  confirmSelf(checkInId?: string) {
    const ci = this.openCheckIn(checkInId);
    if (ci.phase !== "awaiting_confirmation") throw new HttpError(409, ci.phase === "resolved" ? "This check-in is already finished." : "Please answer the question first.");
    const txn = this.txn(ci.txnId);
    const res = releaseByRosa(txn, this.state.rules, { explicitConfirmation: true, scamFlag: ci.risk ? isScamFlag(ci.risk) : false });
    ci.transcript.push(this.line("rosa", "Yes, this was me. Please continue.", "quick_reply"));
    if (!res.ok) {
      ci.transcript.push(this.line("helper", res.reason, "system"));
      this.log("rules", `Rosa asked to continue; not allowed: ${res.reason}`, ci.id);
      this.emit();
      return { ok: false, reason: res.reason };
    }
    txn.status = "released";
    ci.outcome = "released_by_rosa";
    ci.phase = "resolved";
    ci.resolvedAt = nowIso();
    ci.outcomeHeadline = this.headlineFor("released_by_rosa", txn);
    ci.transcript.push(this.line("helper", this.replyFor("released_by_rosa", txn, ci.risk ?? classifyAnswer("")), "system"));
    this.log("rosa", "Rosa confirmed it was her.", ci.id);
    this.log("rules", `Released by Rosa under a self-release rule. Her next ${money(txn.amount)} try at ${shortMerchant(txn.merchant)} will go through (SIMULATED).`, ci.id);
    this.alert({ level: "info", title: `Mom confirmed ${money(txn.amount)} at ${shortMerchant(txn.merchant)}`, body: "She checked in and said it was her own purchase. No action needed.", checkInId: ci.id, txnId: txn.id });
    void this.memory.remember({
      id: `confirmed-${ci.id}`,
      kind: "incident",
      meta: { outcome: "released_by_rosa" },
      text: `Rosa confirmed a ${money(txn.amount)} purchase at ${txn.merchant} herself: "${ci.risk?.evidence_quote ?? ""}". No scam signs.`,
    });
    this.emit();
    return { ok: true, reason: res.reason };
  }

  /** Rosa closes the outcome screen. Persisted, so a refresh doesn't bring it back. */
  dismissCheckIn(checkInId: string) {
    const ci = this.state.checkIns.find((c) => c.id === checkInId);
    if (!ci) throw new HttpError(404, "Check-in not found");
    if (ci.phase !== "resolved") throw new HttpError(409, "Please answer the question first.");
    ci.rosaDismissedAt = nowIso();
    this.emit();
  }

  /** Plain-English answer to "Why?" for any transaction (deterministic, from the rules that fired). */
  why(txnId?: string) {
    const ci = txnId ? undefined : this.activeCheckIn;
    const txn = txnId ? this.txn(txnId) : ci ? this.txn(ci.txnId) : this.state.transactions.find((t) => t.status !== "approved");
    if (!txn) return { text: "Nothing has been paused, Rosa. Your card is working normally." };
    const usual = this.state.stats.find((s) => s.merchantId === txn.merchantId);
    if (txn.status === "approved") {
      return { text: `This was ${money(txn.amount)} at ${shortMerchant(txn.merchant)}.${usual ? ` You usually spend about ${roughMoney(usual.median)} there.` : ""} It matched your usual shopping, so nothing interrupted you.` };
    }
    const rules = this.state.rules.filter((r) => txn.firedRuleIds.includes(r.id));
    const parts = [`Your card was used for ${money(txn.amount)} at ${shortMerchant(txn.merchant)}.`];
    if (usual) parts.push(`You usually spend about ${roughMoney(usual.median)} there.`);
    const SAY: Record<string, (r: SafetyRule) => string> = {
      single_purchase_checkin: (r) => `you and Priya agreed I would check in on any purchase over ${roughMoney(r.params.thresholdUsd ?? 0)}`,
      merchant_anomaly_checkin: () => "it is far above what you usually spend at that store",
      funds_transfer_block: () => "you and Priya agreed that money transfers are always stopped",
      scam_safety_block: () => "you chose the scam-safety rule, which keeps a payment stopped if a check-in sounds like a scam",
    };
    if (rules.length) parts.push(`I ${txn.status === "blocked" ? "stopped" : "paused"} it because ${rules.map((r) => SAY[r.kind](r)).join(", and ")}.`);
    if (txn.status === "blocked") parts.push("So the payment is stopped. Only you and Priya together can change that.");
    else if (txn.status === "paused") parts.push("So the payment is waiting while I check with you.");
    else if (txn.status === "released") parts.push("You confirmed it was you, so it can go through.");
    if (ci && !txnId) this.log("rosa", "Rosa asked why the payment was paused.", ci.id);
    this.emit();
    return { text: parts.join(" ") };
  }

  // ---------------------------------------------------------------- family contact
  callMom(action: "start" | "end") {
    this.state.callMom = { at: nowIso(), status: action === "start" ? "calling" : "ended" };
    if (action === "start") this.log("priya", "Priya called Mom (simulated call).");
    this.emit();
  }

  sendMessage(from: "rosa" | "priya", raw: string) {
    const text = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!text) throw new HttpError(400, "Please write a message.");
    if (text.length > 280) throw new HttpError(400, "Please keep the message short.");
    this.state.messages.unshift({ id: id("msg"), from, text, at: nowIso() });
    this.state.messages = this.state.messages.slice(0, 50);
    this.log(from, `${from === "rosa" ? "Rosa" : "Priya"} sent a message: "${text}"`);
    this.emit();
  }

  markRead(messageId: string) {
    const m = this.state.messages.find((x) => x.id === messageId);
    if (!m) throw new HttpError(404, "Message not found");
    m.readAt ??= nowIso();
    this.emit();
  }

  acknowledge(alertId: string) {
    const a = this.state.alerts.find((x) => x.id === alertId);
    if (!a) throw new HttpError(404, "Alert not found");
    a.acknowledged = true;
    a.acknowledgedAt = nowIso();
    this.log("priya", `Priya marked "${a.title}" as handled.`);
    this.emit();
  }
}
