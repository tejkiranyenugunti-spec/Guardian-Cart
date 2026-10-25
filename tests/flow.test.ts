// End-to-end service flow with EVERY external service offline (the demo's worst case).
import { beforeEach, describe, expect, it } from "vitest";
import { simulate } from "./helpers";

process.env.GUARDIANCART_OFFLINE = "1";
process.env.GUARDIANCART_STEP_MS = "0";
const { Guardian } = await import("../server/guardian");
const { Memory } = await import("../server/memory");

let g: InstanceType<typeof Guardian>;
const SCAM = "Yes, the Microsoft man told me to buy gift cards.";

async function signed(optIn = true) {
  g = new Guardian(new Memory());
  await g.init();
  g.setScamOptIn(optIn);
  g.sign("rosa");
  g.sign("priya");
}

describe("P0 flow (offline fallbacks)", () => {
  beforeEach(() => signed(true));

  it("runs the full 12-step scam flow", async () => {
    const groc = await simulate(g, "grocery");
    expect(groc.status).toBe("approved");
    expect(g.state.alerts).toHaveLength(0); // Priya not pinged for normal life

    const cvs = await simulate(g, "cvs500");
    expect(cvs.status).toBe("paused");
    expect(cvs.simulated).toBe(true);
    const ci = g.activeCheckIn!;
    expect(ci.question).toMatch(/\$500 at CVS/);
    expect(ci.question).toMatch(/Is someone on the phone asking you to buy something\?/);
    expect(ci.question).not.toMatch(/gift/i); // the card can't know items
    expect(ci.cardFacts.map((f) => f.value).join(" ")).not.toMatch(/gift/i);
    expect(g.state.alerts[0].level).toBe("info");

    await g.answer(SCAM, "typed");
    const done = g.activeCheckIn!;
    expect(done.outcome).toBe("blocked_scam");
    expect(g.state.transactions[0].status).toBe("blocked");
    expect(g.state.transactions[0].firedRuleIds).toContain("rule-scam-safety");
    expect(done.risk?.pattern).toBe("tech_support_impersonation");
    expect(done.risk?.payment_request).toBe("gift_cards");
    expect(done.risk?.source).toBe("rosa_answer");
    expect(done.riskSource).toBe("rules_only");
    const reply = done.transcript[done.transcript.length - 1].text;
    expect(reply).toMatch(/hang up/);
    expect(reply).toMatch(/did not go through/);
    const urgent = g.state.alerts.find((a) => a.level === "urgent")!;
    expect(urgent.body).toMatch(/Microsoft/);
    expect(urgent.body).toMatch(/gift cards/);
    expect(done.rosaFacts.join(" ")).toMatch(/gift cards/);
    expect(done.scamMatches.length).toBeGreaterThan(0);
    expect(g.state.timeline.some((t) => t.actor === "memory" && /Saved this check-in/.test(t.text))).toBe(true);

    // The block can't be undone by Rosa alone, or by more answers.
    expect(() => g.confirmSelf()).toThrow();
    await expect(g.answer("No it's fine, this was me", "typed")).rejects.toThrow();
    expect(g.state.transactions[0].status).toBe("blocked");
    expect(g.why().text).toMatch(/scam-safety rule/);
  });

  it("voice, typed and quick reply produce identical downstream behavior", async () => {
    const outcomes: string[] = [];
    for (const via of ["voice", "typed", "quick_reply"] as const) {
      await signed(true);
      await simulate(g, "cvs500");
      await g.answer(SCAM, via);
      outcomes.push(`${g.activeCheckIn!.outcome}/${g.state.transactions[0].status}`);
    }
    expect(new Set(outcomes).size).toBe(1);
  });

  it("without the scam-safety opt-in, a scam answer keeps the payment PAUSED (not blocked) and Rosa can't self-release", async () => {
    await signed(false);
    await simulate(g, "cvs500");
    await g.answer(SCAM, "typed");
    expect(g.activeCheckIn!.outcome).toBe("paused_concern");
    expect(g.state.transactions[0].status).toBe("paused");
    expect(g.state.alerts.some((a) => a.level === "urgent")).toBe(true);
    expect(() => g.confirmSelf()).toThrow(); // check-in resolved; no self-release path
    expect(g.state.transactions[0].status).toBe("paused");
  });

  it("genuine purchase: Rosa releases it herself; Priya only gets an info note", async () => {
    await simulate(g, "medical640");
    await g.answer("No, this was me. It's my new walker, the doctor ordered it.", "voice");
    expect(g.activeCheckIn!.phase).toBe("awaiting_confirmation");
    expect(g.state.transactions[0].status).toBe("paused"); // never auto-released
    const r = g.confirmSelf();
    expect(r.ok).toBe(true);
    expect(g.state.transactions[0].status).toBe("released");
    expect(g.state.alerts.every((a) => a.level === "info")).toBe(true);
  });

  it("a later 'no it's fine' can't erase an earlier scam signal in the same check-in", async () => {
    await signed(false);
    await simulate(g, "medical640");
    await g.answer("Someone on the phone told me what to buy", "typed");
    expect(g.activeCheckIn!.phase).toBe("resolved");
  });

  it("unclear answer stays paused and waits for Rosa", async () => {
    await simulate(g, "cvs500");
    await g.answer("I'm not sure what you mean", "typed");
    expect(g.activeCheckIn!.phase).toBe("awaiting_confirmation");
    expect(g.state.transactions[0].status).toBe("paused");
    await g.answer("Yes, someone is on the phone asking me to buy something.", "quick_reply");
    expect(g.state.transactions[0].status).toBe("blocked");
  });

  it("hard-blocks a wire transfer without a check-in and alerts Priya", async () => {
    const t = await simulate(g, "wire900");
    expect(t.status).toBe("blocked");
    expect(g.state.rosaNotice?.body).toMatch(/hang up/);
    expect(g.state.alerts[0].level).toBe("urgent");
  });

  it("remembers the earlier incident in the next check-in, and reset forgets it", async () => {
    await simulate(g, "cvs500");
    await g.answer(SCAM, "typed");
    await simulate(g, "medical640");
    expect(g.activeCheckIn!.question).toMatch(/Last time, a caller who said he was from Microsoft asked you to buy gift cards/);
    await g.reset({ keepAgreement: true });
    await simulate(g, "cvs500");
    expect(g.activeCheckIn!.question).not.toMatch(/Last time/);
  });

  it("rejects invalid input and out-of-order actions", async () => {
    await expect(g.answer("hello", "typed")).rejects.toThrow(/no check-in/);
    await simulate(g, "cvs500");
    await expect(g.answer("   ", "typed")).rejects.toThrow(/say or type/);
    await expect(g.answer("x".repeat(600), "typed")).rejects.toThrow(/too long/);
    // A normal purchase during an open check-in is still processed automatically.
    expect((await simulate(g, "grocery")).status).toBe("approved");
    expect(() => g.scenarioEvent("nope" as never)).toThrow(/Unknown scenario/);
    const fresh = new Guardian(new Memory());
    await fresh.init();
    // Before both agree, no rules are enforced: the payment is approved, not paused.
    expect((await simulate(fresh, "cvs500")).status).toBe("approved");
  });

  it("after both agreed, turning the scam rule off is only a proposal until Priya agrees", () => {
    g.setScamOptIn(false);
    expect(g.state.agreement.scamSafetyOptIn).toBe(true);
    expect(g.state.ruleChanges[0].status).toBe("pending");
  });
});
