export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { db } = await import("@/lib/db/client");
    await db.automation.updateMany({
      where: { status: { in: ["STARTING", "RUNNING", "RETRYING", "WAITING_FOR_STREAM", "RATE_LIMITED", "WAITING_FOR_TRIGGER", "TRIGGER_QUEUED"] } },
      data: { status: "STOPPED", nextSendAt: null, lastError: "Application restarted; start the automation again." },
    });
    await db.automationExecution.updateMany({ where: { endedAt: null }, data: { endedAt: new Date(), status: "STOPPED", completionNote: "Application restarted." } });
    await db.appSetting.updateMany({ where: { key: "streamlabsMode" }, data: { value: JSON.stringify({ enabled: false, phase: "OFF", reason: "Application restarted. Turn Streamlabs mode on to listen again." }) } });
  } catch {
    // Database initialization may not have run on the very first launch.
  }
}
