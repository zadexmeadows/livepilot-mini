import type { Page } from "playwright";
import { db } from "@/lib/db/client";
import { browserManager } from "@/lib/browser/browser-manager";
import { sendChatMessage, type ChatResult } from "@/lib/browser/youtube-chat";
import { activityLog } from "@/lib/logger/activity-logger";
import { emitDashboardEvent } from "@/lib/events";
import { getSessionCompletionReason } from "./session-limits";
import { isTransientBrowserError, MAX_TRANSIENT_RETRIES, retryDelaySeconds } from "./retry-policy";
import { StreamlabsController } from "./streamlabs-controller";
import { accountAccess } from "./account-access";
import type { StreamlabsConfig } from "./streamlabs-controller";

type Worker = { abort: AbortController; promise: Promise<void> };
const terminal = new Set(["STOPPED", "COMPLETED", "AUTH_REQUIRED", "ERROR"]);

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const aborted = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export class AutomationController {
  private workers = new Map<string, Worker>();
  private starting = new Set<string>();
  private streamlabs = new StreamlabsController();

  constructor(private readonly delay = abortableDelay) {}

  isRunning(id: string) { return this.workers.has(id); }
  runningCount() { return this.workers.size + this.streamlabs.runningCount(); }
  streamlabsState() { return this.streamlabs.snapshot(); }

  streamlabsLoad() { return this.streamlabs.load(); }
  streamlabsConfigure(config: StreamlabsConfig) { return this.streamlabs.configure(config); }
  streamlabsUpdateYouTubeUrl(youtubeUrl: string) { return this.streamlabs.updateYouTubeUrl(youtubeUrl); }
  streamlabsStart(config?: StreamlabsConfig) { return this.streamlabs.start(config); }
  streamlabsPause() { return this.streamlabs.pause(); }
  streamlabsStop() { return this.streamlabs.stop(); }
  streamlabsCheckPoints() { return this.streamlabs.checkPoints(); }
  streamlabsSweepPoints() { return this.streamlabs.sweepPoints(); }
  streamlabsTransferPoints(fromAccountId: string, toAccountId: string, amount: number) { return this.streamlabs.transferPoints(fromAccountId, toAccountId, amount); }
  streamlabsCancelPoints() { return this.streamlabs.cancelIntelligence(); }

  async beforeMutation(id: string) {
    if (this.isRunning(id)) await this.stop(id);
  }

  async start(id: string) {
    return this.startInterval(id);
  }

  private async startInterval(id: string) {
    if (this.workers.has(id) || this.starting.has(id)) return { started: false, reason: "This automation already has an active worker." };
    this.starting.add(id);
    try {
    const automation = await db.automation.findUnique({ where: { id }, include: { googleAccount: true } });
    if (!automation) throw new Error("Automation not found.");
    if (automation.googleAccount.status !== "CONNECTED") {
      await this.setStatus(id, "AUTH_REQUIRED", "Reconnect the selected Google account before starting.");
      return { started: false, reason: "The selected account must be reconnected." };
    }
    const abort = new AbortController();
    const promise = this.run(id, abort.signal).finally(() => this.workers.delete(id));
    this.workers.set(id, { abort, promise });
    return { started: true };
    } finally { this.starting.delete(id); }
  }

  async pause(id: string) {
    await this.pauseInterval(id);
  }

  private async pauseInterval(id: string) {
    const worker = this.workers.get(id);
    worker?.abort.abort();
    if (worker) await worker.promise.catch(() => undefined);
    await this.setStatus(id, "PAUSED", null);
    await activityLog({ automationId: id, action: "AUTOMATION_PAUSED", status: "PAUSED", message: "Automation paused." });
  }

  async stop(id: string) {
    const worker = this.workers.get(id);
    worker?.abort.abort();
    if (worker) await worker.promise.catch(() => undefined);
    await this.setStatus(id, "STOPPED", null, { nextSendAt: null, sessionMessagesSent: 0 });
    await activityLog({ automationId: id, action: "AUTOMATION_STOPPED", status: "STOPPED", message: "Automation stopped." });
  }

  async stopAll() {
    const sequenceCount = this.streamlabs.runningCount();
    if (this.streamlabs.snapshot().enabled || sequenceCount > 0) await this.streamlabs.stop("Emergency Stop All.");
    const ids = [...this.workers.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
    await db.automation.updateMany({ where: { status: { in: ["STARTING", "RUNNING", "RETRYING", "WAITING_FOR_STREAM", "RATE_LIMITED", "WAITING_FOR_TRIGGER", "TRIGGER_QUEUED"] } }, data: { status: "STOPPED", nextSendAt: null } });
    await activityLog({ level: "WARNING", action: "EMERGENCY_STOP", status: "STOPPED", message: `Emergency stop completed. ${ids.length + sequenceCount} active workers stopped.` });
    emitDashboardEvent("automation.stop-all", { count: ids.length });
    return ids.length + sequenceCount;
  }

  private async setStatus(id: string, status: string, lastError: string | null, extra: Record<string, unknown> = {}) {
    const automation = await db.automation.update({ where: { id }, data: { status, lastError, ...extra } });
    emitDashboardEvent("automation.updated", automation);
    return automation;
  }

  private async run(id: string, signal: AbortSignal) {
    const startedAt = new Date();
    let executionId: string | undefined;
    let page: Page | undefined;
    let accountId: string | undefined;
    let consecutiveFailures = 0;
    const closeOnAbort = () => { void page?.close().catch(() => undefined); };
    try {
      let automation = await db.automation.findUniqueOrThrow({ where: { id }, include: { googleAccount: true } });
      accountId = automation.googleAccountId;
      await this.setStatus(id, "STARTING", null, { sessionMessagesSent: 0, nextSendAt: null });
      const execution = await db.automationExecution.create({ data: { automationId: id, status: "STARTING" } });
      executionId = execution.id;
      await activityLog({ automationId: id, action: "AUTOMATION_STARTED", status: "STARTING", message: "Automation worker started.", stream: automation.youtubeUrl });

      if (automation.scheduleMode === "SCHEDULED" && automation.scheduledStartAt && automation.scheduledStartAt > new Date()) {
        await this.setStatus(id, "STARTING", null, { nextSendAt: automation.scheduledStartAt });
        await activityLog({ automationId: id, action: "SCHEDULE_WAIT", status: "STARTING", message: `Waiting until ${automation.scheduledStartAt.toLocaleString()} to start.` });
        await this.delay(automation.scheduledStartAt.getTime() - Date.now(), signal);
      }

      signal.throwIfAborted();
      signal.addEventListener("abort", closeOnAbort, { once: true });

      while (!signal.aborted) {
        automation = await db.automation.findUniqueOrThrow({ where: { id }, include: { googleAccount: true } });
        const completion = getSessionCompletionReason(automation, startedAt);
        if (completion) {
          await this.setStatus(id, "COMPLETED", null, { nextSendAt: null });
          await activityLog({ automationId: id, level: "SUCCESS", action: "AUTOMATION_COMPLETED", status: "COMPLETED", message: completion });
          await db.automationExecution.update({ where: { id: execution.id }, data: { status: "COMPLETED", endedAt: new Date(), completionNote: completion } });
          return;
        }

        await this.setStatus(id, "RUNNING", null, { nextSendAt: new Date() });
        let result: ChatResult;
        // Recover only browser/transport failures. Database and programming errors
        // are handled by the outer catch, not retried as if a send had failed.
        try {
          if (!page || page.isClosed()) {
            page = await browserManager.newPage(automation.googleAccountId);
            signal.throwIfAborted();
            await activityLog({ automationId: id, action: "BROWSER_READY", status: "RUNNING", message: `Isolated browser page opened for ${automation.googleAccount.displayName}.` });
          }
          result = await accountAccess.run(automation.googleAccountId, signal, () => sendChatMessage(page!, automation.youtubeUrl, automation.message, signal));
        } catch (error) {
          if (signal.aborted) return;
          if (!isTransientBrowserError(error)) throw error;
          result = { ok: false, status: "ERROR", retryable: true, reason: "Temporary browser or network failure. Any in-flight delivery is uncertain; retrying only after a delay." };
        }
        if (result.streamTitle || result.channelName) {
          await db.automation.update({ where: { id }, data: { streamTitle: result.streamTitle, channelName: result.channelName } });
        }

        if (result.ok) {
          consecutiveFailures = 0;
          const now = new Date();
          const nextSendAt = new Date(now.getTime() + automation.intervalSeconds * 1000);
          const updated = await db.automation.update({ where: { id }, data: { status: "RUNNING", messagesSent: { increment: 1 }, sessionMessagesSent: { increment: 1 }, lastSentAt: now, nextSendAt, lastError: null } });
          await db.automationExecution.update({ where: { id: execution.id }, data: { status: "RUNNING", messagesSent: { increment: 1 } } });
          await activityLog({ automationId: id, level: "SUCCESS", action: "MESSAGE_SENT", status: "RUNNING", message: "Message sent successfully through YouTube live chat.", stream: automation.youtubeUrl });
          emitDashboardEvent("message.sent", updated);
          await this.delay(automation.intervalSeconds * 1000, signal);
          continue;
        }

        let reason = result.reason ?? "YouTube did not accept the message.";
        if (result.status === "AUTH_REQUIRED") {
          await this.setStatus(id, "AUTH_REQUIRED", reason, { nextSendAt: null });
          await db.googleAccount.update({ where: { id: automation.googleAccountId }, data: { status: "AUTH_REQUIRED" } });
          await activityLog({ automationId: id, level: "ERROR", action: "AUTH_REQUIRED", status: "AUTH_REQUIRED", message: "Automation paused because the browser session needs reconnection.", errorMessage: reason });
          break;
        }

        if (result.status === "WAITING_FOR_STREAM") {
          const retrySeconds = Math.max(60, automation.intervalSeconds);
          await this.setStatus(id, "WAITING_FOR_STREAM", reason, { nextSendAt: new Date(Date.now() + retrySeconds * 1000) });
          await activityLog({ automationId: id, level: "WARNING", action: "WAITING_FOR_STREAM", status: "WAITING_FOR_STREAM", message: reason });
          await this.delay(retrySeconds * 1000, signal);
          continue;
        }

        if (result.status === "RATE_LIMITED") {
          const retrySeconds = Math.max(result.retryAfterSeconds ?? 60, automation.intervalSeconds);
          await this.setStatus(id, "RATE_LIMITED", reason, { nextSendAt: new Date(Date.now() + retrySeconds * 1000) });
          await activityLog({ automationId: id, level: "WARNING", action: "RATE_LIMITED", status: "RATE_LIMITED", message: reason });
          await this.delay(retrySeconds * 1000, signal);
          continue;
        }

        if (result.retryable) {
          consecutiveFailures++;
          await db.automationExecution.update({ where: { id: execution.id }, data: { errorCount: { increment: 1 } } });
          if (consecutiveFailures <= MAX_TRANSIENT_RETRIES) {
            const retrySeconds = Math.max(result.retryAfterSeconds ?? 0, retryDelaySeconds(consecutiveFailures, automation.intervalSeconds));
            await this.setStatus(id, "RETRYING", reason, { nextSendAt: new Date(Date.now() + retrySeconds * 1000) });
            await activityLog({ automationId: id, level: "WARNING", action: "RETRY_SCHEDULED", status: "RETRYING", message: `Temporary failure. Retry ${consecutiveFailures}/${MAX_TRANSIENT_RETRIES} scheduled in ${retrySeconds} seconds.`, errorMessage: reason, stream: automation.youtubeUrl });
            // Never close another worker's tab or the account's shared context.
            if (page) await browserManager.closePage(automation.googleAccountId, page);
            page = undefined;
            await this.delay(retrySeconds * 1000, signal);
            continue;
          }
          reason = `Stopped after ${consecutiveFailures} consecutive failed attempts (${MAX_TRANSIENT_RETRIES} delayed retries). ${reason}`;
        }

        await this.setStatus(id, "ERROR", reason, { nextSendAt: null });
        await db.automationExecution.update({ where: { id: execution.id }, data: { ...(result.retryable ? {} : { errorCount: { increment: 1 } }), status: "ERROR", completionNote: reason, endedAt: new Date() } });
        await activityLog({ automationId: id, level: "ERROR", action: "MESSAGE_FAILED", status: "ERROR", message: "Automation stopped after a YouTube chat error.", errorMessage: reason });
        break;
      }
    } catch (error) {
      if (signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "Unexpected automation error.";
      await this.setStatus(id, "ERROR", message, { nextSendAt: null }).catch(() => undefined);
      if (executionId) await db.automationExecution.update({ where: { id: executionId }, data: { status: "ERROR", errorCount: { increment: 1 }, endedAt: new Date(), completionNote: message } }).catch(() => undefined);
      await activityLog({ automationId: id, level: "ERROR", action: "WORKER_ERROR", status: "ERROR", message: "The isolated automation worker encountered an error.", errorMessage: message }).catch(() => undefined);
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
      if (page && accountId) await browserManager.closePage(accountId, page);
      if (executionId) {
        const current = await db.automation.findUnique({ where: { id } }).catch(() => null);
        if (current && !terminal.has(current.status)) await db.automationExecution.update({ where: { id: executionId }, data: { endedAt: new Date(), status: current.status } }).catch(() => undefined);
      }
    }
  }
}

// Route bundles and development reloads must share the same job/mode owner.
const globalAutomation = globalThis as unknown as { livepilotAutomationController?: AutomationController };
export const automationController = globalAutomation.livepilotAutomationController ?? new AutomationController();
globalAutomation.livepilotAutomationController = automationController;
