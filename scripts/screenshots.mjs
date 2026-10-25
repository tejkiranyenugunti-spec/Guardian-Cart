// Presentation mode check: runs the scripted flow on /stage (stage household) and saves screenshots.
// Usage: (server running) node scripts/screenshots.mjs [outDir]
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8787";
const OUT = process.argv[2] ?? "screenshots/stage";
fs.mkdirSync(OUT, { recursive: true });
const post = (p, body = {}) => fetch(`${BASE}/api/stage${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

await post("/reset", { keepRules: false });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/stage?mute=1`);
await sleep(1200);
const tablet = page.locator(".device.tablet");
const phone = page.locator(".device.phone");
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
await shot("01-setup");
await tablet.getByRole("switch", { name: /scam/ }).click();
await tablet.getByRole("button", { name: "I agree to these rules" }).click();
await phone.getByRole("button", { name: "I agree to these rules" }).click();
await sleep(600);
await shot("02-agreed");
await page.keyboard.press("1");
await sleep(800);
await shot("03-grocery");
await page.keyboard.press("2");
await tablet.getByText("Is someone on the phone asking you to buy something?").first().waitFor();
await sleep(400);
await shot("04-checkin");
await page.keyboard.press("3");
await tablet.getByText("Please hang up the phone.").waitFor({ timeout: 15000 });
await phone.locator(".fam-urgent").waitFor();
await sleep(900);
await shot("05-outcome");
await tablet.getByRole("button", { name: /Why was this paused/ }).first().click();
await sleep(500);
await shot("06-why");
console.log(errors.length ? `PAGE ERRORS:\n${errors.join("\n")}` : "stage flow OK, no page errors");
await browser.close();
