import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const source = async (path) => compile(await readFile(new URL(path, import.meta.url), "utf8"));
const { getSessionCompletionReason } = await import(moduleUrl(await source("../lib/automation/session-limits.ts")));
const selectorUrl = moduleUrl(await source("../lib/browser/selectors.ts"));
const chatUrl = moduleUrl((await source("../lib/browser/youtube-chat.ts")).replace('from "./selectors"', `from "${selectorUrl}"`));
const schemaCode = (await source("../lib/validation/schemas.ts"))
  .replace('from "zod"', `from "${import.meta.resolve("zod")}"`)
  .replace('from "@/lib/browser/youtube-chat"', `from "${chatUrl}"`);
const { automationInputSchema } = await import(moduleUrl(schemaCode));
const start = new Date("2026-08-30T00:00:00Z");
const limits = { runUntilStopped: false, maxMessages: 100, sessionMessagesSent: 99, stopMode: "NONE", stopValue: null, stopAt: null };
const valid = { name: "Limit test", youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", googleAccountId: "test", message: "test", intervalSeconds: 30, maxMessages: 100 };

test("limited sessions stop at their configured count", () => {
  assert.equal(getSessionCompletionReason(limits, start), null);
  assert.match(getSessionCompletionReason({ ...limits, sessionMessagesSent: 100 }, start), /Maximum messages/);
});
test("manual-stop sessions continue beyond both configured and old maximum counts", () => {
  for (const count of [100, 10000, 10001, 1000000]) {
    assert.equal(getSessionCompletionReason({ ...limits, runUntilStopped: true, sessionMessagesSent: count }, start), null);
  }
});
test("switching back to limited mode restores count enforcement", () => {
  const unlimited = { ...limits, runUntilStopped: true, sessionMessagesSent: 120 };
  assert.equal(getSessionCompletionReason(unlimited, start), null);
  assert.match(getSessionCompletionReason({ ...unlimited, runUntilStopped: false }, start), /Maximum messages/);
});
for (const [stopMode, stopValue, stopAt, now] of [
  ["MESSAGES", 10, null, start.getTime()],
  ["MINUTES", 1, null, start.getTime() + 60000],
  ["HOURS", 1, null, start.getTime() + 3600000],
  ["DATETIME", null, start, start.getTime()],
]) {
  test(`existing ${stopMode} automatic stop remains enforced in limited mode`, () => {
    assert.match(getSessionCompletionReason({ ...limits, stopMode, stopValue, stopAt }, start, now), /Configured/);
  });
}
test("legacy API requests default to limited mode", () => {
  assert.equal(automationInputSchema.parse(valid).runUntilStopped, false);
});
test("manual-stop mode persists only with a real boolean", () => {
  assert.equal(automationInputSchema.parse({ ...valid, runUntilStopped: true }).runUntilStopped, true);
  assert.equal(automationInputSchema.safeParse({ ...valid, runUntilStopped: "false" }).success, false);
});
test("manual-stop mode rejects contradictory automatic stopping", () => {
  for (const extra of [{ stopMode: "MESSAGES", stopValue: 5 }, { stopMode: "MINUTES", stopValue: 5 }, { stopAt: start.toISOString() }]) {
    assert.equal(automationInputSchema.safeParse({ ...valid, runUntilStopped: true, ...extra }).success, false);
  }
});
test("manual-stop mode still enforces the minimum interval and validates finite limits", () => {
  assert.equal(automationInputSchema.safeParse({ ...valid, runUntilStopped: true, intervalSeconds: 1 }).success, false);
  for (const maxMessages of [0, -1, 10001]) assert.equal(automationInputSchema.safeParse({ ...valid, maxMessages }).success, false);
});
