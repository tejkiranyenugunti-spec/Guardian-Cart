// Records a silent backup video of the full P0 flow on the split-screen stage.
// Usage: (server running) node scripts/record-demo.mjs  -> demo-recording/*.webm
// Note: headless browsers record no audio. Record a version with voice on a real laptop too.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8787";
const OUT = "demo-recording";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, body = {}) => fetch(`${BASE}/api/stage${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

await post("/reset", { keepRules: false });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, recordVideo: { dir: OUT, size: { width: 1600, height: 1000 } } });
const page = await ctx.newPage();
await page.goto(`${BASE}/stage?mute=1`);
await sleep(2500);

const tablet = page.locator(".device.tablet");
const phone = page.locator(".device.phone");
await tablet.getByRole("switch", { name: /scam/ }).click();
await sleep(1500);
await tablet.getByRole("button", { name: "I agree to these rules" }).click();
await sleep(1500);
await phone.getByRole("button", { name: "I agree to these rules" }).click();
await sleep(2500);
await page.getByRole("button", { name: /Groceries at Safeway/ }).click();
await sleep(3000);
await page.getByRole("button", { name: /\$500 at CVS/ }).click();
await sleep(5000);
await tablet.getByRole("button", { name: /Type my answer instead/ }).click();
await sleep(500);
await tablet.getByLabel("Type your answer").pressSequentially("Yes, the Microsoft man told me to buy gift cards.", { delay: 45 });
await sleep(600);
await tablet.getByRole("button", { name: "Send" }).click();
await sleep(7000);
await phone.locator(".fam-main").evaluate((el) => el.scrollTo({ top: 640, behavior: "smooth" }));
await sleep(3500);
await phone.locator(".fam-main").evaluate((el) => el.scrollTo({ top: 0, behavior: "smooth" }));
await sleep(1500);
await tablet.getByRole("button", { name: /Why was this paused/ }).first().click();
await sleep(5000);
await phone.getByRole("button", { name: "Call Mom" }).click();
await sleep(3500);
await ctx.close();
await browser.close();
const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm"));
const latest = files.map((f) => ({ f, t: fs.statSync(`${OUT}/${f}`).mtimeMs })).sort((a, b) => b.t - a.t)[0];
if (latest) fs.renameSync(`${OUT}/${latest.f}`, `${OUT}/guardiancart-backup-demo.webm`);
console.log(`Saved ${OUT}/guardiancart-backup-demo.webm`);
