// Claude: contextualizes the check-in and interprets Rosa's answer.
// It has NO authority to block or release. It returns text and a structured risk signal;
// the deterministic policy engine (shared/policy.ts) decides everything about the payment.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CONFIG, hasClaude } from "./config";
import type { CardAuthorization, MemoryHit, RiskSignal, TranscriptLine } from "../shared/types";
import { money, roughMoney, sanitizeRiskSignal } from "../shared/policy";

let client: Anthropic | undefined;
function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 0 });
  return client;
}

export const KEY_QUESTION = "Is someone on the phone asking you to buy something?";

const SYSTEM_BASE = `You are part of GuardianCart, a payment safety helper for Rosa, a 78-year-old woman who lives independently.
Rosa and her daughter Priya agreed on safety rules together. When a card payment looks unusual, the payment is paused by fixed rules and the helper checks in with Rosa.

Hard facts about your role:
- You have NO authority over payments. You never block, release, approve, or change limits. Fixed code does that.
- The card network only knows: merchant, merchant category, amount, in-store vs online, time, and which rule fired. It NEVER knows what items were bought. Never say or imply the card knows items (for example gift cards).
- Anything about callers, gift cards, or pressure can only come from Rosa's own words.
- Rosa is an adult in charge of her own life. Be warm, plain, and respectful. Never condescending.`;

// ------------------------------------------------------------------ question

const QuestionSchema = z.object({
  context_sentence: z
    .string()
    .describe("ONE short sentence, max 22 words, addressed to Rosa by name, stating the amount and store and how it compares with her usual. No question."),
});

export function templateContextSentence(auth: CardAuthorization, usualMedian?: number) {
  const usual = usualMedian ? ` You usually spend about ${roughMoney(usualMedian)} there.` : " That's much more than usual.";
  return `Rosa, your card was just used for ${money(auth.amount)} at ${shortMerchant(auth.merchant)}.${usual}`;
}

export function shortMerchant(m: string) {
  return m.replace(/ Pharmacy$/, "");
}

/** Validate a generated sentence before Rosa hears it. */
export function validContextSentence(s: string, auth: CardAuthorization) {
  const amount = money(auth.amount);
  const words = s.trim().split(/\s+/).length;
  return (
    s.includes(amount) &&
    s.toLowerCase().includes(shortMerchant(auth.merchant).toLowerCase().split(" ")[0]) &&
    !/gift|card number|scam|fraud|block|declin/i.test(s.replace(/your card/gi, "")) &&
    !s.includes("?") &&
    words <= 30
  );
}

export async function writeQuestion(
  auth: CardAuthorization,
  usualMemory: MemoryHit | undefined,
  usualMedian: number | undefined,
): Promise<{ text: string; source: "claude" | "template"; error?: string }> {
  const fallback = `${templateContextSentence(auth, usualMedian)} ${KEY_QUESTION}`;
  if (!hasClaude()) return { text: fallback, source: "template" };
  try {
    const res = await getClient().messages.parse(
      {
        model: CONFIG.anthropic.fastModel,
        max_tokens: 1024,
        output_config: { effort: "low", format: zodOutputFormat(QuestionSchema) },
        system: `${SYSTEM_BASE}\n\nWrite the first sentence the helper speaks out loud when the payment pauses. It will be followed by the fixed question "${KEY_QUESTION}". Keep it calm and simple, like a kind neighbor. Use whole dollars when the amount is whole.`,
        messages: [
          {
            role: "user",
            content: `FROM THE CARD (all the card knows): merchant=${auth.merchant}; category=${auth.category}; amount=${money(auth.amount)}; channel=${auth.channel === "in_store" ? "in store" : "online"}.\nFROM ROSA'S MEMORY: ${usualMemory?.text ?? "no history at this store"}`,
          },
        ],
      },
      { timeout: CONFIG.anthropic.questionTimeoutMs },
    );
    const s = res.parsed_output?.context_sentence?.trim() ?? "";
    if (res.stop_reason === "refusal" || !validContextSentence(s, auth)) {
      return { text: fallback, source: "template", error: "Generated sentence failed validation" };
    }
    return { text: `${s} ${KEY_QUESTION}`, source: "claude" };
  } catch (e) {
    return { text: fallback, source: "template", error: describeError(e) };
  }
}

// ------------------------------------------------------------------ risk assessment

const RiskSchema = z.object({
  scam_risk: z.enum(["none", "low", "medium", "high"]).describe("high = Rosa's words show someone is pressuring or instructing her to pay (impersonation, gift cards, secrecy, urgency)."),
  pattern: z.enum([
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
  ]),
  payment_request: z.enum(["gift_cards", "wire_transfer", "crypto", "cash", "none", "unknown"]).describe("Only what ROSA said she was asked to buy or pay with."),
  pressure_signals: z.array(z.string()).describe("Short phrases, e.g. 'caller claims to be Microsoft'."),
  rosa_says_own_purchase: z.boolean().describe("True only if Rosa clearly says the purchase is her own idea and no one is directing her."),
  evidence_quote: z.string().describe("An exact quote copied from Rosa's words."),
  reason: z.string().describe("One short, plain sentence (max 22 words) a 78-year-old would understand, explaining why this does or doesn't sound like a scam. No jargon. Don't mention whether the payment went through."),
  family_summary: z.string().describe("One or two plain sentences for Priya. Separate what the card showed from what Rosa said. Max 45 words."),
});

/** A Claude-written reason may be spoken to Rosa only if it is short, plain, and makes no payment-status claim. */
export function validRosaReason(s?: string) {
  if (!s) return false;
  const t = s.trim();
  return (
    t.length > 10 &&
    t.split(/\s+/).length <= 26 &&
    !/(went through|did not go through|didn't go through|approved|released|blocked|declined|unblock|refund|AI|model|risk|signal|policy)/i.test(t)
  );
}

export interface Assessment {
  signal?: RiskSignal;
  familySummary?: string;
  reason?: string;
  source: "claude" | "unavailable";
  error?: string;
}

export async function assessAnswer(input: {
  auth: CardAuthorization;
  firedRuleTitles: string[];
  transcript: TranscriptLine[];
  latestAnswer: string;
  usualMemory?: MemoryHit;
  scamMatches: MemoryHit[];
  priorIncidents: MemoryHit[];
}): Promise<Assessment> {
  if (!hasClaude()) return { source: "unavailable", error: "Claude not configured" };
  const convo = input.transcript.map((l) => `${l.speaker === "rosa" ? "ROSA" : "HELPER"}: ${l.text}`).join("\n");
  try {
    const res = await getClient().messages.parse(
      {
        model: CONFIG.anthropic.reasoningModel,
        max_tokens: 2048,
        output_config: { effort: "low", format: zodOutputFormat(RiskSchema) },
        system: `${SYSTEM_BASE}\n\nYour job now: read Rosa's answer and report a structured risk signal. Coached scam victims often say "yes it was me" while someone on the phone directs them, so weigh any mention of a caller, instructions, urgency, secrecy, gift cards, wires or crypto heavily. If Rosa says someone on the phone is asking her to buy it, that is high risk. Do not invent details Rosa did not say. Your output cannot release or approve anything.`,
        messages: [
          {
            role: "user",
            content: [
              `FROM THE CARD: ${input.auth.merchant} (${input.auth.category}), ${money(input.auth.amount)}, ${input.auth.channel === "in_store" ? "in store" : "online"}. Rules that paused it: ${input.firedRuleTitles.join("; ")}.`,
              `ROSA'S USUAL PATTERN (memory): ${input.usualMemory?.text ?? "none on file"}`,
              `SIMILAR KNOWN SCAM SCRIPTS (memory): ${input.scamMatches.map((m) => m.text).join(" | ") || "none"}`,
              `ROSA'S EARLIER CHECK-INS (memory): ${input.priorIncidents.map((m) => m.text).join(" | ") || "none"}`,
              `CONVERSATION SO FAR:\n${convo}`,
              `ROSA'S LATEST ANSWER: "${input.latestAnswer}"`,
            ].join("\n\n"),
          },
        ],
      },
      { timeout: CONFIG.anthropic.assessTimeoutMs },
    );
    if (res.stop_reason === "refusal" || !res.parsed_output) {
      return { source: "unavailable", error: `No structured output (stop_reason=${res.stop_reason})` };
    }
    const allRosa = input.transcript.filter((l) => l.speaker === "rosa").map((l) => l.text).join(" ");
    const signal = sanitizeRiskSignal({ ...res.parsed_output, detectors: ["claude"] }, allRosa || input.latestAnswer);
    const summary = res.parsed_output.family_summary?.trim();
    const reason = res.parsed_output.reason?.trim();
    return { signal, familySummary: summary && summary.length < 400 ? summary : undefined, reason: reason && reason.length < 300 ? reason : undefined, source: "claude" };
  } catch (e) {
    return { source: "unavailable", error: describeError(e) };
  }
}

function describeError(e: unknown) {
  if (e instanceof Anthropic.AuthenticationError) return "Claude authentication failed (check ANTHROPIC_API_KEY)";
  if (e instanceof Anthropic.RateLimitError) return "Claude rate limited";
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "Claude timed out";
  if (e instanceof Anthropic.APIConnectionError) return "Claude unreachable (network)";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}`;
  return (e as Error)?.message ?? "Unknown Claude error";
}
