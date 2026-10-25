import { describe, expect, it } from "vitest";
import { classifyAnswer, rosaFactsFrom } from "../shared/classifier";

describe("classifyAnswer (deterministic fallback)", () => {
  it("demo answer -> high, tech support, gift cards", () => {
    const s = classifyAnswer("Yes, the Microsoft man told me to buy gift cards.");
    expect(s.scam_risk).toBe("high");
    expect(s.pattern).toBe("tech_support_impersonation");
    expect(s.payment_request).toBe("gift_cards");
    expect(rosaFactsFrom(s).join(" ")).toMatch(/gift cards/);
  });
  it.each([
    ["The IRS said I'd be arrested unless I pay with Google Play cards", "government_impersonation"],
    ["My grandson is in jail and needs bail money, he said don't tell anyone", "family_emergency"],
    ["yes someone is on the phone", "phone_pressure_purchase"],
    ["A man on the phone told me what to buy", "phone_pressure_purchase"],
  ])("%s -> high", (text, pattern) => {
    const s = classifyAnswer(text);
    expect(s.scam_risk).toBe("high");
    expect(s.pattern).toBe(pattern);
  });
  it("genuine purchase -> none, own purchase", () => {
    const s = classifyAnswer("No, this was me. It's my new walker, the doctor ordered it.");
    expect(s.scam_risk).toBe("none");
    expect(s.rosa_says_own_purchase).toBe(true);
  });
  it("quick reply 'No, this was me' -> none", () => {
    expect(classifyAnswer("No, this was me").scam_risk).toBe("none");
  });
  it("vague answer -> low, not own purchase", () => {
    const s = classifyAnswer("I'm not sure what you mean");
    expect(s.scam_risk).toBe("low");
    expect(s.rosa_says_own_purchase).toBe(false);
  });
  it("mention of gift cards alone -> at least medium", () => {
    expect(["medium", "high"]).toContain(classifyAnswer("I'm buying some gift cards").scam_risk);
  });
});
