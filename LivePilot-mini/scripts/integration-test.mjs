import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const accountId = "integration-test-account";
let automationId;

async function request(path, options) {
  const response = await fetch(baseUrl + path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${path} returned HTTP ${response.status}`);
  return body;
}

async function main() {
  await request("/api/stats");
  const mode = await request("/api/streamlabs");
  if (mode.enabled) throw new Error("Stop Streamlabs mode before running the local integration test.");
  const invalidMode = await fetch(baseUrl + "/api/streamlabs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: "true" }) });
  if (invalidMode.status !== 400) throw new Error("Streamlabs mode must require a real boolean.");
  const crossSite = await fetch(baseUrl + "/api/streamlabs", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" }, body: JSON.stringify({ enabled: true }) });
  if (crossSite.status !== 403) throw new Error("Cross-site mode changes must be rejected.");
  await db.streamlabsTrigger.create({ data: { videoId: "integration-test", messageId: "duplicate-test" } });
  try {
    await db.streamlabsTrigger.create({ data: { videoId: "integration-test", messageId: "duplicate-test" } });
    throw new Error("Duplicate announcement claim was accepted.");
  } catch (error) { if (error.code !== "P2002") throw error; }
  finally { await db.streamlabsTrigger.deleteMany({ where: { videoId: "integration-test" } }); }
  await db.googleAccount.upsert({
    where: { id: accountId },
    create: { id: accountId, displayName: "Integration Test", status: "CONNECTED", profileDirectory: "./work/integration-profile", connectedAt: new Date() },
    update: { status: "CONNECTED" },
  });
  const created = await request("/api/automations", { method: "POST", body: JSON.stringify({
    name: "Integration CRUD Test", youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", googleAccountId: accountId,
    message: "Integration test message", intervalSeconds: 30, scheduleMode: "SCHEDULED",
    scheduledStartAt: new Date(Date.now() + 10 * 60_000).toISOString(), stopMode: "NONE", stopValue: null, stopAt: null,
    maxMessages: 2, start: false,
  }) });
  automationId = created.id;
  if (created.runUntilStopped !== false) throw new Error("Legacy requests must keep a finite session limit.");
  const updated = await request(`/api/automations/${automationId}`, { method: "PUT", body: JSON.stringify({
    name: "Integration CRUD Test Updated", youtubeUrl: created.youtubeUrl, googleAccountId: accountId,
    message: "Updated integration test message", intervalSeconds: 30, scheduleMode: "SCHEDULED",
    scheduledStartAt: new Date(Date.now() + 10 * 60_000).toISOString(), stopMode: "NONE", stopValue: null, stopAt: null, maxMessages: 2, runUntilStopped: true,
  }) });
  if (updated.name !== "Integration CRUD Test Updated") throw new Error("Automation update test failed.");
  if (updated.runUntilStopped !== true || !(await request(`/api/automations/${automationId}`)).runUntilStopped) throw new Error("Manual-stop choice was not persisted.");
  const limited = await request(`/api/automations/${automationId}`, { method: "PUT", body: JSON.stringify({ ...updated, runUntilStopped: false }) });
  if (limited.runUntilStopped !== false) throw new Error("Could not restore limited mode.");
  await request(`/api/automations/${automationId}`, { method: "PUT", body: JSON.stringify({ ...updated, runUntilStopped: true }) });
  const started = await request(`/api/automations/${automationId}/action`, { method: "POST", body: JSON.stringify({ action: "start" }) });
  if (!started.started) throw new Error(started.reason || "Worker start test failed.");
  const duplicate = await request(`/api/automations/${automationId}/action`, { method: "POST", body: JSON.stringify({ action: "start" }) });
  if (duplicate.started !== false) throw new Error("Duplicate worker prevention test failed.");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await request(`/api/automations/${automationId}/action`, { method: "POST", body: JSON.stringify({ action: "pause" }) });
  if ((await request(`/api/automations/${automationId}`)).status !== "PAUSED") throw new Error("Unlimited worker pause failed.");
  await request(`/api/automations/${automationId}/action`, { method: "POST", body: JSON.stringify({ action: "start" }) });
  await request(`/api/automations/${automationId}/action`, { method: "POST", body: JSON.stringify({ action: "stop" }) });
  const stopped = await request(`/api/automations/${automationId}`);
  if (stopped.status !== "STOPPED") throw new Error("Worker stop test failed.");
  await request(`/api/automations/${automationId}`, { method: "DELETE" });
  automationId = undefined;
  await db.googleAccount.delete({ where: { id: accountId } });
  console.log("Integration test passed: API CRUD, persistent finite/manual-stop modes, duplicate prevention, pause/resume and manual stop. No browser was opened or messages sent (start scheduled in the future).");
}

main().catch(async (error) => {
  console.error(error);
  if (automationId) await db.automation.delete({ where: { id: automationId } }).catch(() => undefined);
  await db.googleAccount.delete({ where: { id: accountId } }).catch(() => undefined);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
