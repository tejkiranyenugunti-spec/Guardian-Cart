import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG, hasCartesia, hasClaude, hasMoss } from "./config";
import { HttpError, type Guardian } from "./guardian";
import { createServices, HOUSEHOLDS, isHousehold, UnknownCard } from "./pipeline";
import { InvalidTransactionEvent } from "./transactions";
import { synthesize, transcribe, VoiceUnavailable } from "./voice";
import { SCENARIOS, type ScenarioId } from "../shared/data";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.GUARDIANCART_DATA_DIR || path.join(here, "..", "data");
const services = await createServices({ dataDir });
const app = express();
app.use(express.json({ limit: "64kb" }));

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      next(e);
    }
  };

function hh(req: Request): Guardian {
  const id = String(req.params.hh);
  if (!isHousehold(id)) throw new HttpError(404, "Unknown household");
  return services.households.get(id)!;
}
const who = (v: unknown) => {
  if (v !== "rosa" && v !== "priya") throw new HttpError(400, "who must be rosa or priya");
  return v;
};

// ---------------------------------------------------------------- health
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    claude: hasClaude(),
    cartesia: hasCartesia(),
    moss: hasMoss(),
    offline: CONFIG.offline,
    provider: { name: services.provider.name, kind: services.provider.kind },
    households: Object.keys(HOUSEHOLDS),
  }),
);

// ---------------------------------------------------------------- card network (SimulatedTransactionProvider webhook)
// A real network would push authorizations here. Body: TransactionEvent fields. card_id selects the household.
app.post(
  "/api/transactions",
  wrap(async (req) => services.provider.submit(req.body, HOUSEHOLDS.home.cardId)),
);
app.post(
  "/api/:hh/transactions",
  wrap(async (req) => {
    const g = hh(req);
    return services.provider.submit({ ...req.body, card_id: g.state.provider.cardId }, g.state.provider.cardId);
  }),
);

// ---------------------------------------------------------------- household state + realtime
app.get("/api/:hh/state", wrap((req) => hh(req).snapshot()));
app.get("/api/:hh/events", (req, res, next) => {
  let g: Guardian;
  try {
    g = hh(req);
  } catch (e) {
    return next(e);
  }
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (s: unknown) => res.write(`data: ${JSON.stringify(s)}\n\n`);
  send(g.snapshot());
  const off = g.subscribe(send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    off();
    clearInterval(ping);
  });
});

// ---------------------------------------------------------------- rules
app.post("/api/:hh/setup/opt-in", wrap((req) => hh(req).setScamOptIn(Boolean(req.body?.optIn))));
app.post("/api/:hh/setup/sign", wrap((req) => void hh(req).sign(who(req.body?.who))));
app.post("/api/:hh/rules/edit", wrap((req) => hh(req).editRules(who(req.body?.who), req.body?.edit ?? {})));
app.post("/api/:hh/rules/respond", wrap((req) => hh(req).respondToChange(who(req.body?.who), String(req.body?.changeId), req.body?.accept === true)));

// ---------------------------------------------------------------- check-ins
app.post(
  "/api/:hh/checkin/answer",
  wrap(async (req) => {
    const via = ["voice", "typed", "quick_reply"].includes(req.body?.via) ? req.body.via : "typed";
    const ci = await hh(req).answer(String(req.body?.text ?? ""), via, req.body?.checkInId);
    return { ok: true, outcome: ci.outcome, phase: ci.phase };
  }),
);
app.post("/api/:hh/checkin/confirm", wrap((req) => hh(req).confirmSelf(req.body?.checkInId)));
app.post("/api/:hh/checkin/dismiss", wrap((req) => hh(req).dismissCheckIn(String(req.body?.checkInId))));
app.post("/api/:hh/why", wrap((req) => hh(req).why(req.body?.txnId)));

// ---------------------------------------------------------------- family contact
app.post("/api/:hh/call-mom", wrap((req) => hh(req).callMom(req.body?.action === "end" ? "end" : "start")));
app.post("/api/:hh/messages", wrap((req) => hh(req).sendMessage(who(req.body?.from), String(req.body?.text ?? ""))));
app.post("/api/:hh/messages/:id/read", wrap((req) => hh(req).markRead(String(req.params.id))));
app.post("/api/:hh/alerts/:id/ack", wrap((req) => hh(req).acknowledge(String(req.params.id))));

// ---------------------------------------------------------------- presentation mode only
app.post(
  "/api/stage/simulate",
  wrap(async (req) => {
    const scenario = req.body?.scenario as ScenarioId;
    if (!(scenario in SCENARIOS)) throw new HttpError(400, "Unknown scenario");
    const g = services.households.get("stage")!;
    // Same provider, same pipeline as every other card event.
    return services.provider.submit(g.scenarioEvent(scenario), HOUSEHOLDS.stage.cardId);
  }),
);
app.post(
  "/api/stage/reset",
  wrap(async (req) => {
    await services.households.get("stage")!.reset({ keepAgreement: req.body?.keepRules === true });
  }),
);

// ---------------------------------------------------------------- voice (Cartesia proxy)
app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text ?? "").trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: "No text" });
  try {
    const audio = await synthesize(text);
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store" }).send(audio);
  } catch (e) {
    const unavailable = e instanceof VoiceUnavailable;
    if (!unavailable) console.warn("[tts]", (e as Error).message);
    res.status(503).json({ error: unavailable ? "tts_unavailable" : "tts_failed", fallback: "browser" });
  }
});

app.post("/api/stt", express.raw({ type: ["audio/*", "application/octet-stream"], limit: "8mb" }), async (req, res) => {
  const buf = req.body as Buffer;
  if (!Buffer.isBuffer(buf) || buf.length < 1000) return res.status(400).json({ error: "I didn't catch that. Please hold the button while you speak." });
  try {
    const text = await transcribe(buf, String(req.headers["content-type"] ?? "audio/webm"));
    if (!text) return res.status(422).json({ error: "I didn't catch that. Please try again or type your answer." });
    res.json({ text });
  } catch (e) {
    const unavailable = e instanceof VoiceUnavailable;
    if (!unavailable) console.warn("[stt]", (e as Error).message);
    res.status(503).json({ error: unavailable ? "stt_unavailable" : "Voice didn't work this time. Please tap an answer or type it." });
  }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// ---------------------------------------------------------------- web app
const dist = path.join(here, "..", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if ((err as { type?: string })?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request." });
  const status = err instanceof HttpError ? err.status : err instanceof InvalidTransactionEvent ? 400 : err instanceof UnknownCard ? 404 : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof Error && status < 500 ? err.message : "Something went wrong. Please try again." });
});

const shutdown = () => {
  services.flushAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

app.listen(CONFIG.port, () => {
  const mode = (b: boolean) => (b ? "LIVE" : "fallback");
  const home = services.households.get("home")!;
  console.log(`\n  GuardianCart running on http://localhost:${CONFIG.port}`);
  console.log(`    Rosa's app:            http://localhost:${CONFIG.port}/rosa`);
  console.log(`    Priya's app:           http://localhost:${CONFIG.port}/family`);
  console.log(`    Card simulator:        http://localhost:${CONFIG.port}/card-simulator`);
  console.log(`    Presentation (stage):  http://localhost:${CONFIG.port}/stage`);
  console.log(`  Data: ${dataDir}  (home has ${home.state.transactions.length} live transactions)`);
  console.log(`  Claude: ${mode(hasClaude())} · Cartesia: ${mode(hasCartesia())} · Moss: ${home.memory.mode === "live" ? "LIVE" : "fallback"} · Card feed: ${services.provider.name} (SIMULATED)\n`);
});
