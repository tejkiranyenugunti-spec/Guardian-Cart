// The real user-driven MVP: provider -> pipeline -> automatic state transitions -> persistence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.GUARDIANCART_OFFLINE = "1";
process.env.GUARDIANCART_STEP_MS = "0";
const { createServices, HOUSEHOLDS, TransactionPipeline } = await import("../server/pipeline");
const { Guardian } = await import("../server/guardian");
const { Memory } = await import("../server/memory");
const { InvalidTransactionEvent, RealVisaTransactionProvider, ProviderNotConfigured, normalizeEvent } = await import("../server/transactions");
import type { VisaTransactionProvider, EventHandler } from "../server/transactions";

const HOME = HOUSEHOLDS.home.cardId;
const SCAM = "Yes, the Microsoft man told me to buy gift cards.";
const safeway = { merchant: "Safeway", merchant_category: "5411", amount: 46.18, channel: "in_store", transaction_type: "purchase" };
const cvs = { merchant: "CVS Pharmacy", merchant_category: "5912", amount: 500, channel: "in_store", transaction_type: "purchase" };

async function agreed(services: Awaited<ReturnType<typeof createServices>>, optIn = true) {
  const g = services.households.get("home")!;
  if (optIn) g.setScamOptIn(true);
  g.sign("rosa");
  g.sign("priya");
  return g;
}

describe("transaction pipeline (no buttons involved)", () => {
  it("processes events automatically: normal passes, unusual pauses and Rosa gets a check-in", async () => {
    const s = await createServices({ dataDir: null });
    const g = await agreed(s);
    const r1 = await s.provider.submit({ ...safeway, transaction_id: "t-1" }, HOME);
    expect(r1).toMatchObject({ decision: "approve", status: "approved", household: "home" });
    expect(g.state.transactions[0]).toMatchObject({ id: "t-1", status: "approved", simulated: true, source: "simulated", merchantId: "safeway" });
    expect(g.state.alerts).toHaveLength(0);

    const r2 = await s.provider.submit({ ...cvs, transaction_id: "t-2" }, HOME);
    expect(r2).toMatchObject({ decision: "decline", status: "paused" });
    await g.idle();
    const ci = g.activeCheckIn!;
    expect(ci.txnId).toBe("t-2");
    expect(ci.question).toMatch(/\$500 at CVS/);
    // Priya does NOT get an urgent alert while the payment is only paused.
    expect(g.state.alerts.some((a) => a.level === "urgent")).toBe(false);

    await g.answer(SCAM, "typed");
    expect(g.state.transactions.find((t) => t.id === "t-2")!.status).toBe("blocked");
    expect(g.state.alerts[0].level).toBe("urgent");
    expect(g.activeCheckIn!.familyNotifiedAt).toBeTruthy();
  });

  it("is idempotent on transaction_id", async () => {
    const s = await createServices({ dataDir: null });
    const g = await agreed(s);
    await s.provider.submit({ ...safeway, transaction_id: "dup" }, HOME);
    const again = await s.provider.submit({ ...safeway, transaction_id: "dup" }, HOME);
    expect(again.status).toBe("duplicate");
    expect(g.state.transactions.filter((t) => t.id === "dup")).toHaveLength(1);
  });

  it("validates events", async () => {
    const s = await createServices({ dataDir: null });
    await expect(s.provider.submit({ ...safeway, amount: -1 }, HOME)).rejects.toBeInstanceOf(InvalidTransactionEvent);
    await expect(s.provider.submit({ ...safeway, merchant_category: "grocery" }, HOME)).rejects.toBeInstanceOf(InvalidTransactionEvent);
    await expect(s.provider.submit({ ...safeway, merchant: "" }, HOME)).rejects.toBeInstanceOf(InvalidTransactionEvent);
    await expect(s.provider.submit({ ...safeway, transaction_type: "teleport" }, HOME)).rejects.toBeInstanceOf(InvalidTransactionEvent);
    await expect(s.provider.submit({ ...safeway, card_id: "card-unknown" }, HOME)).rejects.toThrow(/Unknown card/);
  });

  it("blocks funds transfers by transaction type, even at an unlisted MCC", async () => {
    const s = await createServices({ dataDir: null });
    const g = await agreed(s);
    const r = await s.provider.submit({ merchant: "PayFast", merchant_category: "7399", amount: 300, channel: "online", transaction_type: "funds_transfer" }, HOME);
    expect(r.status).toBe("blocked");
    expect(g.state.alerts[0].level).toBe("urgent");
  });

  it("queues check-ins: the oldest open one is shown first", async () => {
    const s = await createServices({ dataDir: null });
    const g = await agreed(s);
    await s.provider.submit({ ...cvs, transaction_id: "a" }, HOME);
    await s.provider.submit({ merchant: "Bay Mobility & Medical", merchant_category: "5976", amount: 640, channel: "in_store", transaction_id: "b" }, HOME);
    await g.idle();
    expect(g.activeCheckIn!.txnId).toBe("a");
    await g.answer(SCAM, "typed");
    expect(g.activeCheckIn!.txnId).toBe("b"); // next open check-in takes over
  });

  it("keeps the stage household separate from Rosa's real data", async () => {
    const s = await createServices({ dataDir: null });
    const stage = s.households.get("stage")!;
    stage.setScamOptIn(true);
    stage.sign("rosa");
    stage.sign("priya");
    await s.provider.submit(stage.scenarioEvent("grocery"), HOUSEHOLDS.stage.cardId);
    expect(stage.state.transactions).toHaveLength(1);
    expect(s.households.get("home")!.state.transactions).toHaveLength(0);
  });
});

describe("provider interface", () => {
  it("any VisaTransactionProvider can drive the same pipeline", async () => {
    class FakeVisa implements VisaTransactionProvider {
      readonly name = "Fake Visa sandbox";
      readonly kind = "visa" as const;
      handler?: EventHandler;
      isConfigured() {
        return true;
      }
      async start(h: EventHandler) {
        this.handler = h;
      }
      async stop() {}
      push(raw: unknown) {
        return this.handler!(normalizeEvent(raw, { card_id: "card-x", source: "visa" }));
      }
    }
    const g = new Guardian(new Memory(), { household: "x", cardId: "card-x", cardLabel: "x", demoMode: false });
    await g.init();
    g.setScamOptIn(true);
    g.sign("rosa");
    g.sign("priya");
    const p = new FakeVisa();
    await p.start(new TransactionPipeline(new Map([["x", g]]), { x: "card-x" }).handle);
    const r = await p.push(cvs);
    expect(r.status).toBe("paused");
    expect(g.state.transactions[0].source).toBe("visa");
  });

  it("the real Visa provider is an honest placeholder", async () => {
    const real = new RealVisaTransactionProvider();
    expect(real.isConfigured()).toBe(false);
    await expect(real.start(async () => ({}) as never)).rejects.toBeInstanceOf(ProviderNotConfigured);
  });
});

describe("rule changes need both people", () => {
  it("Priya proposes, nothing changes until Rosa agrees", async () => {
    const s = await createServices({ dataDir: null });
    const g = await agreed(s);
    const r = g.editRules("priya", { thresholdUsd: 300 });
    expect(r.pending).toBe(true);
    expect(g.state.rules.find((x) => x.kind === "single_purchase_checkin")!.params.thresholdUsd).toBe(200);
    // $250 still pauses under the old rule
    await s.provider.submit({ ...cvs, amount: 250, merchant: "New Shop", merchant_category: "5999", transaction_id: "p1" }, HOME);
    expect(g.state.transactions[0].status).toBe("paused");
    expect(() => g.respondToChange("priya", g.state.ruleChanges[0].id, true)).toThrow();
    g.respondToChange("rosa", g.state.ruleChanges[0].id, true);
    expect(g.state.ruleChanges[0].status).toBe("agreed");
    expect(g.state.rules.find((x) => x.kind === "single_purchase_checkin")!.params.thresholdUsd).toBe(300);
  });

  it("Rosa can decline a proposal", async () => {
    const s = await createServices({ dataDir: null });
    const g = await agreed(s);
    g.editRules("priya", { scamSafety: false });
    g.respondToChange("rosa", g.state.ruleChanges[0].id, false);
    expect(g.state.ruleChanges[0]).toMatchObject({ status: "declined", declinedBy: "rosa" });
    expect(g.state.agreement.scamSafetyOptIn).toBe(true);
  });

  it("rejects invalid amounts and Priya choosing the scam rule during setup", async () => {
    const s = await createServices({ dataDir: null });
    const g = s.households.get("home")!;
    expect(() => g.editRules("priya", { thresholdUsd: 123 })).toThrow();
    expect(() => g.editRules("priya", { scamSafety: true })).toThrow(/Rosa's choice/);
  });

  it("editing during setup means the other person must agree again", async () => {
    const s = await createServices({ dataDir: null });
    const g = s.households.get("home")!;
    g.sign("priya");
    g.editRules("rosa", { thresholdUsd: 150 });
    expect(g.state.agreement.priyaSignedAt).toBeUndefined();
  });
});

describe("persistence", () => {
  it("survives a server restart: rules, transactions, check-ins, transcript, alerts, messages, memory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
    const s1 = await createServices({ dataDir: dir });
    const g1 = await agreed(s1);
    await s1.provider.submit({ ...safeway, transaction_id: "keep-1" }, HOME);
    await s1.provider.submit({ ...cvs, transaction_id: "keep-2" }, HOME);
    await g1.idle();
    await g1.answer(SCAM, "voice");
    g1.sendMessage("priya", "I'm calling you now");
    s1.flushAll();
    expect(fs.existsSync(path.join(dir, "home.json"))).toBe(true);
    const raw = fs.readFileSync(path.join(dir, "home.json"), "utf8");
    expect(raw).not.toMatch(/sk-ant|sk_car|integrations/);

    // "Restart": brand-new services reading the same directory.
    const s2 = await createServices({ dataDir: dir });
    const g2 = s2.households.get("home")!;
    expect(g2.state.agreement.rosaSignedAt).toBeTruthy();
    expect(g2.state.transactions.map((t) => [t.id, t.status])).toEqual([
      ["keep-2", "blocked"],
      ["keep-1", "approved"],
    ]);
    const ci = g2.state.checkIns[0];
    expect(ci.transcript.some((l) => l.text === SCAM)).toBe(true);
    expect(g2.state.alerts[0].level).toBe("urgent");
    expect(g2.state.messages[0].text).toBe("I'm calling you now");
    // Memory write-back survived: the next check-in recalls the earlier call.
    await s2.provider.submit({ merchant: "Bay Mobility & Medical", merchant_category: "5976", amount: 640, channel: "in_store" }, HOME);
    await g2.idle();
    expect(g2.state.checkIns[0].question).toMatch(/Last time, a caller who said he was from Microsoft/);
  });

  it("a check-in interrupted mid-analysis is recoverable after restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
    const s1 = await createServices({ dataDir: dir });
    const g1 = await agreed(s1);
    await s1.provider.submit({ ...cvs, transaction_id: "x1" }, HOME);
    await g1.idle();
    g1.state.checkIns[0].phase = "thinking"; // simulate a crash mid-analysis
    g1.sendMessage("rosa", "ok"); // forces a save
    s1.flushAll();
    const s2 = await createServices({ dataDir: dir });
    const g2 = s2.households.get("home")!;
    expect(g2.state.checkIns[0].phase).toBe("asking");
    await g2.answer(SCAM, "typed");
    expect(g2.state.transactions[0].status).toBe("blocked");
  });

  it("a corrupt data file never stops the app", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
    fs.writeFileSync(path.join(dir, "home.json"), "{not json");
    const s = await createServices({ dataDir: dir });
    expect(s.households.get("home")!.state.transactions).toEqual([]);
  });
});
