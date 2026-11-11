import path from "node:path";
import fs from "node:fs/promises";
import { chromium } from "playwright";

async function main() {
  const workspace = path.resolve(".");
  const profile = path.resolve("./work/browser-smoke-profile");
  if (!profile.startsWith(workspace + path.sep)) throw new Error("Smoke-test profile must stay inside the workspace.");
  await fs.rm(profile, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(profile, { headless: false, viewport: null });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("data:text/html,<title>LivePilot browser smoke test</title><h1>Browser session ready</h1>");
  if ((await page.title()) !== "LivePilot browser smoke test") throw new Error("Persistent browser page did not load.");
  await page.waitForTimeout(1000);
  await context.close();
  const files = await fs.readdir(profile);
  if (!files.length) throw new Error("Persistent profile directory was not created.");
  console.log("Browser smoke test passed: headed persistent Chromium profile launched and was saved.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
