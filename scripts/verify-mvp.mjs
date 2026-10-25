// End-to-end verification of the user-driven MVP, including a REAL server restart.
// Starts its own server on a temp data dir (never touches app/data), drives Rosa's and Priya's
// apps in separate browser contexts, and generates card events with the CLI (scripts/txn.mjs).
// Usage: npm run build && node scripts/verify-mvp.mjs [outDir]
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 8791;
const BASE = `http://localhost:${PORT}`;
const OUT = process.argv[2] ?? "screenshots/mvp";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "gc-verify-"));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (n, msg) => {
  results.push(`PASS ${n}. ${msg}`);
  console.log(`PASS ${n}. ${msg}`);
};
const fail = (n, msg) => {
  console.error(`FAIL ${n}. ${msg}`);
  throw new Error(`Step ${n} failed: ${msg}`);
};
const check = (n, cond, msg) => (cond ? pass(n, msg) : fail(n, msg));

let server;
async function startServer() {
  server = spawn("npx", ["tsx", "server/index.ts"], {
    env: { ...process.env, PORT: String(PORT), GUARDIANCART_DATA_DIR: DATA, GUARDIANCART_STEP_MS: "400" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return log;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server did not start:\n${log}`);
}
async function stopServer() {
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
}
const state = () => fetch(`${BASE}/api/home/state`).then((r) => r.json());
const txn = (...args) => execFileSync("node", ["scripts/txn.mjs", ...args], { env: { ...process.env, BASE }, encoding: "utf8" }).trim();

await startServer();
const browser = await chromium.launch();
const errors = [];
const open = async (w, h, url, scale = 1) => {
  const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale })).newPage();
  page.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  await page.goto(`${BASE}${url}`);
  return page;
};

try {
  // 1-2. Rosa's and Priya's normal apps, separately.
  const rosa = await open(1180, 820, "/rosa?mute=1");
  const priya = await open(390, 844, "/family", 2);
  await rosa.getByText("Your safety rules, Rosa").waitFor();
  await priya.getByText("Safety rules for Mom's card").waitFor();
  await sleep(700); await rosa.screenshot({ path: `${OUT}/01-rosa-setup.png` });
  await sleep(700); await priya.screenshot({ path: `${OUT}/02-priya-setup.png` });
  pass(1, "Rosa's app opened at /rosa (first-run rule setup)");
  pass(2, "Priya's app opened separately at /family");

  // Setup through the real UIs: Rosa opts in herself, both agree.
  await rosa.getByRole("switch", { name: /scam/ }).click();
  await rosa.getByRole("button", { name: "I agree to these rules" }).click();
  await priya.getByRole("button", { name: "I agree to these rules" }).click();
  await rosa.getByText(/Everything looks normal/).waitFor();
  await priya.getByText("Mom is doing fine").waitFor();
  await sleep(700); await rosa.screenshot({ path: `${OUT}/03-rosa-home.png` });

  // 3-4. Normal transaction via the provider (CLI -> webhook -> pipeline).
  const out1 = txn("--merchant", "Safeway", "--mcc", "5411", "--amount", "46.18", "--id", "verify-safeway");
  check(3, /APPROVE -> approved/.test(out1), `CLI generated a normal transaction: ${out1.split("\n")[0]}`);
  await rosa.locator(".txn-item", { hasText: "Safeway" }).first().getByText("Normal").waitFor();
  let s = await state();
  check(4, s.transactions[0].status === "approved" && !s.alerts.some((a) => a.level === "urgent") && !(await priya.locator(".fam-urgent").count()), "Safeway passed automatically: NORMAL on Rosa's list, no alert for Priya, no interruption");
  await sleep(700); await rosa.screenshot({ path: `${OUT}/04-rosa-normal.png` });

  // 5-6. Unusual $500 CVS -> paused -> Rosa gets the check-in automatically.
  const out2 = txn("--merchant", "CVS Pharmacy", "--mcc", "5912", "--amount", "500", "--id", "verify-cvs");
  check(5, /DECLINE -> paused/.test(out2), `CLI generated $500 at CVS: ${out2.split("\n")[0]}`);
  await rosa.getByText("Is someone on the phone asking you to buy something?").first().waitFor({ timeout: 10000 });
  await priya.getByText("Checking in with Mom now").waitFor();
  s = await state();
  check(6, s.checkIns[0]?.phase === "asking" && !(await priya.locator(".fam-urgent").count()) && !s.alerts.some((a) => a.level === "urgent"), "Rosa's check-in appeared by itself; Priya sees a calm 'checking in' note, NOT an urgent alert");
  await sleep(700); await rosa.screenshot({ path: `${OUT}/05-rosa-checkin.png` });
  await sleep(700); await priya.screenshot({ path: `${OUT}/06-priya-checking.png` });

  // 7. Rosa answers by typing in her own app.
  await rosa.getByRole("button", { name: /Type my answer instead/ }).click();
  await rosa.getByLabel("Type your answer").fill("Yes, the Microsoft man told me to buy gift cards.");
  await rosa.getByRole("button", { name: "Send" }).click();
  await rosa.getByText("Comparing with scam calls I know about").waitFor();
  await sleep(700); await rosa.screenshot({ path: `${OUT}/07-rosa-thinking.png` });
  pass(7, "Rosa typed her answer in her app");

  // 8-10. Risk analysis -> fixed policy -> Priya alerted automatically.
  await rosa.getByText("Please hang up the phone.").waitFor({ timeout: 15000 });
  s = await state();
  const ci = s.checkIns[0];
  check(8, ci.risk?.scam_risk === "high" && ci.risk.pattern === "tech_support_impersonation" && ci.risk.payment_request === "gift_cards" && s.timeline.some((t) => /Risk analysis: HIGH/.test(t.text)), `Risk analysis ran (path: ${ci.riskSource}; pattern ${ci.risk?.pattern}, payment ${ci.risk?.payment_request})`);
  check(9, s.transactions.find((t) => t.id === "verify-cvs").status === "blocked" && s.transactions.find((t) => t.id === "verify-cvs").firedRuleIds.includes("rule-scam-safety") && s.timeline.some((t) => /scam-safety rule applied/.test(t.text)), "Fixed policy made the decision: BLOCKED under Rosa's opted-in scam-safety rule");
  await priya.locator(".fam-urgent").waitFor({ timeout: 5000 });
  await priya.getByText(/Mom says a caller claiming to be from Microsoft told her to buy gift cards/).waitFor();
  check(10, s.alerts[0].level === "urgent", "Priya's app switched to the urgent alert automatically (no refresh, no button)");
  await sleep(700); await rosa.screenshot({ path: `${OUT}/08-rosa-blocked.png` });
  await sleep(700); await priya.screenshot({ path: `${OUT}/09-priya-urgent.png` });
  await priya.locator(".fam-main").evaluate((el) => el.scrollTo(0, 700));
  await sleep(300);
  await sleep(700); await priya.screenshot({ path: `${OUT}/10-priya-card-vs-rosa.png` });
  const cardText = await priya.locator(".split-col").first().innerText();
  if (/gift/i.test(cardText)) fail(10, "the 'From the card' panel mentions gift cards");

  // 11-12. Refresh both pages.
  await rosa.reload();
  await priya.reload();
  await rosa.getByText("Please hang up the phone.").waitFor();
  await priya.locator(".fam-urgent").waitFor();
  pass(11, "Refreshed both pages");
  check(12, (await rosa.getByText(/told at/).count()) > 0, "State remained after refresh (Rosa still sees the outcome with when Priya was told; Priya still sees the urgent alert)");

  // Rosa closes the outcome; Priya messages Mom and marks it handled; Priya proposes a rule change.
  await rosa.getByRole("button", { name: /Back to home/ }).click();
  await priya.getByRole("button", { name: /Message/ }).click();
  await priya.getByRole("button", { name: "I'm calling you now." }).click();
  await rosa.getByText("Message from Priya").waitFor();
  await sleep(700); await rosa.screenshot({ path: `${OUT}/11-rosa-message.png` });
  await rosa.getByRole("button", { name: "I'm okay" }).click();
  await priya.getByRole("button", { name: "Mark as handled" }).click();
  await priya.getByText("Mom is safe").waitFor();
  await priya.getByRole("button", { name: "Rules" }).click();
  await priya.getByRole("button", { name: "Suggest a rule change" }).click();
  await priya.getByRole("radio", { name: "$150" }).click();
  await priya.getByRole("button", { name: "Send to Mom" }).click();
  await priya.getByText("Waiting for Mom to agree").waitFor();
  await rosa.getByText("Priya suggested a change to your rules").waitFor();
  await rosa.getByRole("button", { name: /Priya suggested a change/ }).click();
  await sleep(700); await rosa.screenshot({ path: `${OUT}/12-rosa-proposal.png` });
  await rosa.getByRole("button", { name: "I agree" }).click();
  await priya.getByText("Mom and you agreed").waitFor();
  await sleep(700); await priya.screenshot({ path: `${OUT}/13-priya-rules.png` });

  // 13-14. Real restart.
  await stopServer();
  await sleep(500);
  await startServer();
  pass(13, "Server stopped (SIGTERM) and started again on the same data directory");
  await rosa.goto(`${BASE}/rosa?mute=1`);
  await priya.goto(`${BASE}/family`);
  s = await state();
  await rosa.getByRole("button", { name: /Past check-ins/ }).click();
  await rosa.getByText(/You said: “Yes, the Microsoft man told me to buy gift cards.”/).waitFor();
  await sleep(700); await rosa.screenshot({ path: `${OUT}/14-rosa-history-after-restart.png` });
  await priya.getByRole("button", { name: "History" }).click();
  await priya.getByText("$500 at CVS Pharmacy").waitFor();
  await sleep(700); await priya.screenshot({ path: `${OUT}/15-priya-history-after-restart.png` });
  const big = s.rules.find((r) => r.kind === "single_purchase_checkin");
  check(
    14,
    s.transactions.length === 2 && s.transactions.find((t) => t.id === "verify-cvs").status === "blocked" && s.checkIns[0].transcript.length >= 3 && s.alerts.some((a) => a.level === "urgent" && a.acknowledged) && s.messages.length === 2 && big.params.thresholdUsd === 150 && s.agreement.rosaSignedAt,
    "Persisted after restart: agreed rules (incl. the $150 change), both transactions and states, the incident + transcript, Priya's handled alert, messages",
  );
  // Memory write-back survived the restart too.
  txn("--merchant", "Bay Mobility & Medical", "--mcc", "5976", "--amount", "640", "--id", "verify-walker");
  await rosa.getByText(/Last time, a caller who said he was from Microsoft/).first().waitFor({ timeout: 10000 });
  await sleep(700); await rosa.screenshot({ path: `${OUT}/16-rosa-memory-after-restart.png` });
  await rosa.getByRole("button", { name: "No, this was me" }).click();
  await rosa.getByRole("button", { name: /Yes, this was me/ }).click();
  await rosa.getByRole("heading", { name: "All set, Rosa." }).waitFor();
  s = await state();
  if (s.alerts.some((a) => a.level === "urgent" && !a.acknowledged)) fail(14, "genuine purchase raised an urgent alert");
  results.push("PASS +. Later check-in recalled the earlier Microsoft call from memory after restart; Rosa released a genuine purchase herself; Priya got only a note");

  // 15. /stage still works, on its own household.
  const homeCount = s.transactions.length;
  execFileSync("node", ["scripts/screenshots.mjs", `${OUT}/stage`], { env: { ...process.env, BASE }, encoding: "utf8" });
  const stage = await fetch(`${BASE}/api/stage/state`).then((r) => r.json());
  const homeAfter = await state();
  check(15, stage.transactions.some((t) => t.status === "blocked") && homeAfter.transactions.length === homeCount, "/stage presentation flow works end to end and did not touch Rosa's real data");
} finally {
  await browser.close();
  await stopServer().catch(() => {});
  console.log(`\n${results.join("\n")}`);
  console.log(errors.length ? `PAGE ERRORS:\n${errors.join("\n")}` : "No page errors.");
  console.log(`Screenshots: ${OUT}   Data dir used: ${DATA}`);
}
