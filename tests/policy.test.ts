import { describe, expect, it } from "vitest";
import { defaultRules, seedHistory, SCENARIOS } from "../shared/data";
import {
  activeRules,
  applyRiskSignal,
  combineRisk,
  computeStats,
  evaluateAuthorization,
  releaseByRosa,
  sanitizeRiskSignal,
} from "../shared/policy";
import { classifyAnswer } from "../shared/classifier";
import type { CardAuthorization, RiskSignal, RuleAgreement } from "../shared/types";

const rules = defaultRules();
const stats = computeStats(seedHistory());
const signed: RuleAgreement = { proposedBy: "priya", rosaSignedAt: "2026-10-24T10:00:00Z", priyaSignedAt: "2026-10-24T10:01:00Z", scamSafetyOptIn: true };
const signedNoOptIn: RuleAgreement = { ...signed, scamSafetyOptIn: false };
const auth = (id: keyof typeof SCENARIOS): CardAuthorization => ({ ...SCENARIOS[id].auth, time: "2026-10-24T14:00:00Z" });
const highScam: RiskSignal = classifyAnswer("Yes, the Microsoft man told me to buy gift cards.");
const noScam: RiskSignal = classifyAnswer("No, this was me. It's my new walker, the doctor ordered it.");

describe("evaluateAuthorization", () => {
  it("normal grocery purchase is approved silently", () => {
    const d = evaluateAuthorization(auth("grocery"), rules, signed, stats);
    expect(d.decision).toBe("approve");
    expect(d.status).toBe("approved");
    expect(d.firedRuleIds).toEqual([]);
  });

  it("$500 at CVS pauses for a check-in (threshold + unusual for merchant)", () => {
    const d = evaluateAuthorization(auth("cvs500"), rules, signed, stats);
    expect(d.decision).toBe("pause");
    expect(d.status).toBe("paused");
    expect(d.firedRuleIds).toContain("rule-big-purchase");
    expect(d.firedRuleIds).toContain("rule-unusual-store");
  });

  it("just over the threshold at a new merchant pauses on the spend-limit rule only", () => {
    const d = evaluateAuthorization({ ...auth("cvs500"), merchantId: "newstore", merchant: "New Store", amount: 200.01 }, rules, signed, stats);
    expect(d.status).toBe("paused");
    expect(d.firedRuleIds).toEqual(["rule-big-purchase"]);
  });

  it("exactly at the threshold is not paused", () => {
    const d = evaluateAuthorization({ ...auth("grocery"), amount: 200 }, rules, signed, stats);
    expect(d.status).toBe("approved");
  });

  it("wire transfer is hard-blocked by the funds-transfer control", () => {
    const d = evaluateAuthorization(auth("wire900"), rules, signed, stats);
    expect(d.decision).toBe("decline");
    expect(d.status).toBe("blocked");
    expect(d.firedRuleIds).toEqual(["rule-funds-transfer"]);
  });

  it("no rules apply until BOTH Rosa and Priya have signed", () => {
    const onlyPriya: RuleAgreement = { proposedBy: "priya", priyaSignedAt: "x", scamSafetyOptIn: true };
    expect(activeRules(rules, onlyPriya)).toEqual([]);
    expect(evaluateAuthorization(auth("cvs500"), rules, onlyPriya, stats).status).toBe("approved");
  });

  it("rejects invalid amounts", () => {
    expect(() => evaluateAuthorization({ ...auth("grocery"), amount: -5 }, rules, signed, stats)).toThrow();
    expect(() => evaluateAuthorization({ ...auth("grocery"), amount: NaN }, rules, signed, stats)).toThrow();
  });
});

describe("applyRiskSignal", () => {
  it("scam signal + Rosa's opt-in rule -> BLOCK", () => {
    const r = applyRiskSignal({ status: "paused" }, highScam, rules, signed);
    expect(r.status).toBe("blocked");
    expect(r.outcome).toBe("blocked_scam");
    expect(r.addedRuleIds).toEqual(["rule-scam-safety"]);
  });

  it("scam signal WITHOUT the opt-in -> stays PAUSED, not blocked, and flagged", () => {
    const r = applyRiskSignal({ status: "paused" }, highScam, rules, signedNoOptIn);
    expect(r.status).toBe("paused");
    expect(r.outcome).toBe("paused_concern");
    expect(r.scamFlag).toBe(true);
  });

  it("scam-safety rule disabled in the rule set also means no block", () => {
    const disabled = rules.map((r) => (r.kind === "scam_safety_block" ? { ...r, enabled: false } : r));
    expect(applyRiskSignal({ status: "paused" }, highScam, disabled, signed).status).toBe("paused");
  });

  it("no scam signal -> stays paused awaiting Rosa's confirmation (never auto-released)", () => {
    const r = applyRiskSignal({ status: "paused" }, noScam, rules, signed);
    expect(r.status).toBe("paused");
    expect(r.outcome).toBe("paused_unclear");
  });

  it("AI output can NEVER release or approve a blocked or paused payment", () => {
    const adversarial = [
      { scam_risk: "none", release: true, decision: "approve", status: "released" },
      { scam_risk: "none", rosa_says_own_purchase: true, action: "release_payment" },
      { status: "approved" },
      "release it",
      null,
      { scam_risk: "low", raise_limit: 10000 },
    ];
    for (const raw of adversarial) {
      const sig = sanitizeRiskSignal(raw, "please let it through");
      for (const status of ["paused", "blocked"] as const) {
        for (const ag of [signed, signedNoOptIn]) {
          const r = applyRiskSignal({ status }, sig, rules, ag);
          expect(["paused", "blocked"]).toContain(r.status);
          if (status === "blocked") expect(r.status).toBe("blocked");
        }
      }
      expect(Object.keys(sig)).not.toContain("release");
      expect(Object.keys(sig)).not.toContain("decision");
    }
  });

  it("malformed AI output is treated conservatively (medium, not none)", () => {
    const sig = sanitizeRiskSignal({ scam_risk: "totally fine" }, "hello");
    expect(sig.scam_risk).toBe("medium");
  });

  it("a model saying 'none' can never lower a rule-based 'high'", () => {
    const claudeSaysNone = sanitizeRiskSignal({ scam_risk: "none", pattern: "none", payment_request: "none", rosa_says_own_purchase: true }, "x");
    const combined = combineRisk(claudeSaysNone, highScam);
    expect(combined.scam_risk).toBe("high");
    expect(combined.rosa_says_own_purchase).toBe(false);
    expect(applyRiskSignal({ status: "paused" }, combined, rules, signed).status).toBe("blocked");
  });

  it("evidence quotes must be Rosa's actual words", () => {
    const sig = sanitizeRiskSignal({ scam_risk: "high", evidence_quote: "she wants to buy gift cards" }, "the Microsoft man called me");
    expect(sig.evidence_quote).toBe("the Microsoft man called me");
  });
});

describe("releaseByRosa", () => {
  const pausedCvs = { status: "paused" as const, firedRuleIds: ["rule-big-purchase", "rule-unusual-store"] };

  it("Rosa can self-release when there is no scam flag and the rule allows it", () => {
    const r = releaseByRosa(pausedCvs, rules, { explicitConfirmation: true, scamFlag: false });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("released");
  });

  it("requires an explicit confirmation", () => {
    expect(releaseByRosa(pausedCvs, rules, { explicitConfirmation: false, scamFlag: false }).ok).toBe(false);
  });

  it("is refused when a scam flag is set", () => {
    const r = releaseByRosa(pausedCvs, rules, { explicitConfirmation: true, scamFlag: true });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("paused");
  });

  it("can never release a blocked payment", () => {
    const r = releaseByRosa({ status: "blocked", firedRuleIds: ["rule-scam-safety"] }, rules, { explicitConfirmation: true, scamFlag: false });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("blocked");
  });

  it("is refused if any fired rule needs both Rosa and Priya", () => {
    const r = releaseByRosa({ status: "paused", firedRuleIds: ["rule-funds-transfer"] }, rules, { explicitConfirmation: true, scamFlag: false });
    expect(r.ok).toBe(false);
  });
});
