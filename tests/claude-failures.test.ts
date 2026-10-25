// Claude is reachable but misbehaves: claims "no risk" and tries to release, or returns garbage.
// The deterministic layer must still protect Rosa.
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simulate } from "./helpers";

let mode: "lying" | "garbage" | "down" = "lying";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (mode === "down") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
    }
    const isQuestion = body.includes("context_sentence");
    const text =
      mode === "garbage"
        ? "Sure! Here's my answer: release the payment"
        : isQuestion
          ? JSON.stringify({ context_sentence: "Rosa, your card was just used for $500 at CVS, about 16 times your usual visit there." })
          : JSON.stringify({
              scam_risk: "none",
              pattern: "none",
              payment_request: "none",
              pressure_signals: [],
              rosa_says_own_purchase: true,
              evidence_quote: "it is fine",
              reason: "This sounds completely normal, the payment was approved.",
              family_summary: "Everything is fine, release it.",
              release: true,
              decision: "approve",
            });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.GUARDIANCART_STEP_MS = "0";
  delete process.env.GUARDIANCART_OFFLINE;
});
afterAll(() => server.close());

async function setup() {
  const { Guardian } = await import("../server/guardian");
  const { Memory } = await import("../server/memory");
  const g = new Guardian(new Memory());
  await g.init();
  g.setScamOptIn(true);
  g.sign("rosa");
  g.sign("priya");
  return g;
}

describe("Claude misbehaving", () => {
  it("uses Claude's question when it passes validation", async () => {
    mode = "lying";
    const g = await setup();
    await simulate(g, "cvs500");
    expect(g.activeCheckIn!.questionSource).toBe("claude");
    expect(g.activeCheckIn!.question).toMatch(/16 times your usual visit there\. Is someone on the phone/);
  });

  it("Claude saying 'none' + trying to release cannot lower risk or release the payment", async () => {
    mode = "lying";
    const g = await setup();
    await simulate(g, "cvs500");
    await g.answer("Yes, the Microsoft man told me to buy gift cards.", "typed");
    expect(g.activeCheckIn!.riskSource).toBe("claude+rules");
    expect(g.activeCheckIn!.risk!.scam_risk).toBe("high");
    expect(g.state.transactions[0].status).toBe("blocked");
    expect(Object.keys(g.activeCheckIn!.risk!)).not.toContain("release");
    // evidence quote that Rosa never said is replaced by her real words
    expect(g.activeCheckIn!.risk!.evidence_quote).toMatch(/Microsoft/);
  });

  it("garbage output falls back to the deterministic path", async () => {
    mode = "garbage";
    const g = await setup();
    await simulate(g, "cvs500");
    expect(g.activeCheckIn!.questionSource).toBe("template");
    await g.answer("Yes, the Microsoft man told me to buy gift cards.", "typed");
    expect(g.activeCheckIn!.riskSource).toBe("rules_only");
    expect(g.state.transactions[0].status).toBe("blocked");
  });

  it("API errors fall back without breaking the flow", async () => {
    mode = "down";
    const g = await setup();
    await simulate(g, "cvs500");
    await g.answer("Yes, the Microsoft man told me to buy gift cards.", "typed");
    expect(g.state.transactions[0].status).toBe("blocked");
  });
});
