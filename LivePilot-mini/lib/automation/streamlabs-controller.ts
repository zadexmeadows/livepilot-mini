import type { GoogleAccount } from "@prisma/client";
import type { Page } from "playwright";
import { db } from "@/lib/db/client";
import { browserManager } from "@/lib/browser/browser-manager";
import { sendChatMessage, detectAccountStatus, detectStreamStatus, parseYouTubeUrl, type ChatResult } from "@/lib/browser/youtube-chat";
import { readStreamlabsChat } from "@/lib/browser/streamlabs-chat";
import { activityLog } from "@/lib/logger/activity-logger";
import { emitDashboardEvent } from "@/lib/events";
import { AnnouncementTracker, isHeistAnnouncement, type ChatAnnouncement } from "./streamlabs-matcher";
import { cancellableDelay } from "./cancellation";
import { accountAccess } from "./account-access";
import { isTransientBrowserError, MAX_TRANSIENT_RETRIES, retryDelaySeconds } from "./retry-policy";
import {
  isStreamlabsMessage, normalizeStreamlabsName, parseHeistCaptain, parseHeistJoin,
  parseHeistResults, parsePointsBalance, parseRoll, parseTransfer, sameStreamlabsName,
} from "./streamlabs-intelligence";

export type StreamlabsBalance = { username: string; balance: number; verifiedAt: string; source: "POINTS" | "ROLL" | "TRANSFER"; sourceMessageId: string };
export type StreamlabsHeistSummary = {
  announcementId: string; startedAt: string; completedAt: string; wager: number;
  participants: { accountId: string; username: string; payout: number; net: number; outcome: "WON" | "LOST" }[];
  totalNet: number; resultsMessageId: string;
};
export type StreamlabsTransferRecord = {
  id: string; donorAccountId: string; bankAccountId: string; donor: string; recipient: string;
  amount: number; status: "CONFIRMED" | "FAILED" | "UNCERTAIN"; createdAt: string; responseMessageId?: string; reason?: string;
};
export type StreamlabsIntelligenceState = {
  phase: "IDLE" | "CHECKING_POINTS" | "PRIMING_BANK" | "SWEEPING" | "TRANSFERRING" | "PAUSED_FOR_HEIST" | "ERROR";
  currentAccountId: string | null; balances: Record<string, StreamlabsBalance>;
  activeHeist: { announcementId: string; captain: string; startedAt: string; participantAccountIds: string[] } | null;
  recentHeists: StreamlabsHeistSummary[]; transfers: StreamlabsTransferRecord[];
  lastDecision: string | null; lastOperationAt: string | null;
};

export type StreamlabsConfig = {
  youtubeUrl: string;
  accountIds: string[];
  messages: string[];
  delaySeconds: number;
  fallbackSeconds: number;
  noMessageRepeats: boolean;
  heistWager: number;
  bankAccountId: string | null;
  bankPresenceMessage: string;
  bankPresenceSeconds: number;
  protectedReserve: number;
  minimumTransfer: number;
  maximumTransfer: number;
  responseTimeoutSeconds: number;
  autoConsolidate: boolean;
};
export type StreamlabsState = {
  enabled: boolean;
  phase: "OFF" | "PAUSED" | "STARTING" | "LISTENING" | "SENDING" | "RETRYING" | "ERROR";
  reason: string | null;
  participants: { id: string; name: string }[];
  round: number;
  currentAccountId: string | null;
  lastAnnouncementAt: string | null;
  lastRoundTrigger: "ANNOUNCEMENT" | "TIMER" | null;
  nextActionAt: string | null;
  config: StreamlabsConfig;
  intelligence: StreamlabsIntelligenceState;
};

const defaults: StreamlabsConfig = {
  youtubeUrl: "", accountIds: [], messages: [], delaySeconds: 10, fallbackSeconds: 300, noMessageRepeats: false,
  heistWager: 1337, bankAccountId: null, bankPresenceMessage: ".",
  bankPresenceSeconds: 120, protectedReserve: 1337, minimumTransfer: 100, maximumTransfer: 5000,
  responseTimeoutSeconds: 20, autoConsolidate: false,
};
const intelligenceDefaults = (): StreamlabsIntelligenceState => ({
  phase: "IDLE", currentAccountId: null, balances: {}, activeHeist: null, recentHeists: [], transfers: [], lastDecision: null, lastOperationAt: null,
});
const cleanName = (value: unknown) => typeof value === "string" ? value.normalize("NFKC").trim().replace(/^@/, "").replace(/\s+/g, " ").slice(0, 100) : "";
const shuffle = <T,>(items: T[]) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
};

export class StreamlabsController {
  private state: StreamlabsState = { enabled: false, phase: "OFF", reason: null, participants: [], round: 0, currentAccountId: null, lastAnnouncementAt: null, lastRoundTrigger: null, nextActionAt: null, config: defaults, intelligence: intelligenceDefaults() };
  private abort?: AbortController;
  private task?: Promise<void>;
  private pages = new Map<string, Page>();
  private blocked = new Set<string>();
  private cooldown = new Map<string, number>();
  private failures = new Map<string, number>();
  private participants: GoogleAccount[] = [];
  private intelligenceSeen = new Set<string>();
  private intelligenceSeeded = false;
  private intelligenceTask?: Promise<void>;
  private intelligenceAbort?: AbortController;
  private announcementVersion = 0;
  private pendingAutoSweep = false;

  constructor(private readonly delay = cancellableDelay) {}
  snapshot() { return { ...this.state, participants: [...this.state.participants], config: { ...this.state.config, accountIds: [...this.state.config.accountIds], messages: [...this.state.config.messages] }, intelligence: { ...this.state.intelligence, balances: { ...this.state.intelligence.balances }, recentHeists: [...this.state.intelligence.recentHeists], transfers: [...this.state.intelligence.transfers], activeHeist: this.state.intelligence.activeHeist ? { ...this.state.intelligence.activeHeist, participantAccountIds: [...this.state.intelligence.activeHeist.participantAccountIds] } : null } }; }
  isRunning() { return this.state.enabled || !!this.task || !!this.intelligenceTask; }
  hasActiveWork() { return this.isRunning(); }
  runningCount() { return this.state.enabled ? this.participants.filter(a => !this.blocked.has(a.id)).length : this.intelligenceTask ? 1 : 0; }

  async load() {
    if (this.isRunning()) return this.snapshot();
    const [stored, intelligence] = await Promise.all([
      db.appSetting.findUnique({ where: { key: "streamlabsConfig" } }),
      db.appSetting.findUnique({ where: { key: "streamlabsIntelligence" } }),
    ]);
    if (stored) {
      try {
        const value = JSON.parse(stored.value);
        delete value.accountUsernames; delete value.bankUsername;
        const loaded = { ...defaults, ...value } as StreamlabsConfig;
        loaded.accountIds = Array.isArray(loaded.accountIds) ? [...new Set(loaded.accountIds.filter((id): id is string => typeof id === "string" && !!id))] : [];
        const existing = loaded.accountIds.length
          ? await db.googleAccount.findMany({ where: { id: { in: loaded.accountIds } }, select: { id: true } })
          : [];
        const existingIds = new Set(existing.map(account => account.id));
        const accountIds = loaded.accountIds.filter(id => existingIds.has(id));
        const bankAccountId = loaded.bankAccountId && accountIds.includes(loaded.bankAccountId) ? loaded.bankAccountId : null;
        this.state.config = { ...loaded, accountIds, bankAccountId };
        if (accountIds.length !== loaded.accountIds.length || bankAccountId !== loaded.bankAccountId) {
          await db.appSetting.upsert({ where: { key: "streamlabsConfig" }, create: { key: "streamlabsConfig", value: JSON.stringify(this.state.config) }, update: { value: JSON.stringify(this.state.config) } });
        }
      } catch { /* retain safe defaults */ }
    }
    else {
      const legacy = await db.automation.findMany({ where: { googleAccount: { status: "CONNECTED" } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      if (legacy.length) {
        const migrated = { ...defaults, youtubeUrl: legacy[0].youtubeUrl, accountIds: [...new Set(legacy.map(item => item.googleAccountId))], messages: [...new Set(legacy.map(item => item.message).filter(Boolean))] };
        this.state.config = migrated;
        await db.appSetting.create({ data: { key: "streamlabsConfig", value: JSON.stringify(migrated) } });
      }
    }
    if (intelligence) {
      try {
        const value = JSON.parse(intelligence.value);
        this.state.intelligence = { ...intelligenceDefaults(), ...value, phase: "IDLE", currentAccountId: null, balances: value.balances ?? {}, recentHeists: value.recentHeists ?? [], transfers: value.transfers ?? [] };
      } catch { /* retain safe defaults */ }
    }
    return this.snapshot();
  }

  private async publish(patch: Partial<StreamlabsState>) {
    this.state = { ...this.state, ...patch };
    await db.appSetting.upsert({ where: { key: "streamlabsState" }, create: { key: "streamlabsState", value: JSON.stringify(this.state) }, update: { value: JSON.stringify(this.state) } });
    emitDashboardEvent("streamlabs.updated", this.snapshot());
  }

  private async publishIntelligence(patch: Partial<StreamlabsIntelligenceState>) {
    this.state.intelligence = { ...this.state.intelligence, ...patch };
    await db.appSetting.upsert({ where: { key: "streamlabsIntelligence" }, create: { key: "streamlabsIntelligence", value: JSON.stringify(this.state.intelligence) }, update: { value: JSON.stringify(this.state.intelligence) } });
    await this.publish({ intelligence: this.state.intelligence });
  }

  private usernameFor(account: GoogleAccount) {
    return account.channelName?.trim().startsWith("@") ? cleanName(account.channelName) : "";
  }

  private accountForUsername(username: string) {
    const normalized = normalizeStreamlabsName(username);
    return this.participants.find(account => normalizeStreamlabsName(this.usernameFor(account)) === normalized);
  }

  async checkPoints() { return this.startIntelligenceOperation("CHECKING_POINTS"); }
  async sweepPoints() { return this.startIntelligenceOperation("SWEEPING"); }
  async transferPoints(fromAccountId: string, toAccountId: string, amount: number) {
    return this.startIntelligenceOperation("TRANSFERRING", false, { fromAccountId, toAccountId, amount });
  }
  async cancelIntelligence() {
    this.intelligenceAbort?.abort(); await this.intelligenceTask?.catch(() => undefined);
    await this.publishIntelligence({ phase: "IDLE", currentAccountId: null, lastDecision: "Points operation stopped." });
    return this.snapshot();
  }

  private async prepareIntelligenceParticipants() {
    await this.load();
    const cfg = this.state.config;
    if (!cfg.youtubeUrl || !cfg.accountIds.length) throw new Error("Configure the livestream and select accounts in Streamlabs Mode first.");
    const accounts = await db.googleAccount.findMany({ where: { id: { in: cfg.accountIds }, status: "CONNECTED" } });
    const byId = new Map(accounts.map(account => [account.id, account]));
    this.participants = cfg.accountIds.map(id => byId.get(id)).filter((account): account is GoogleAccount => !!account);
    if (this.participants.length !== cfg.accountIds.length) throw new Error("Reconnect every selected account before using Points Bank.");
    const missingHandle = this.participants.find(account => !this.usernameFor(account));
    if (missingHandle) throw new Error(`Reconnect ${missingHandle.displayName} so its YouTube channel handle can be detected.`);
  }

  private async startIntelligenceOperation(kind: "CHECKING_POINTS" | "SWEEPING" | "TRANSFERRING", automatic = false, transfer?: { fromAccountId: string; toAccountId: string; amount: number }) {
    if (this.intelligenceTask) throw new Error("A points operation is already running.");
    const standalone = !this.state.enabled && !this.task;
    if (standalone) await this.prepareIntelligenceParticipants();
    if (this.state.phase === "SENDING") throw new Error("Wait for the current Streamlabs round to finish.");
    if (kind === "SWEEPING" && !this.state.config.bankAccountId) throw new Error("Choose a bank account first.");
    if (kind === "TRANSFERRING" && !transfer) throw new Error("Transfer details are required.");
    if (kind === "TRANSFERRING" && transfer) {
      if (!this.participants.some(account => account.id === transfer.fromAccountId) || !this.participants.some(account => account.id === transfer.toAccountId)) throw new Error("Choose two connected Points Bank accounts.");
      if (transfer.fromAccountId === transfer.toAccountId) throw new Error("Sender and recipient must be different accounts.");
      if (!Number.isFinite(transfer.amount) || !Number.isInteger(transfer.amount) || transfer.amount < 1) throw new Error("Transfer amount must be a positive whole number.");
      if (transfer.amount > this.state.config.maximumTransfer) throw new Error(`Transfer amount cannot exceed the configured ${this.state.config.maximumTransfer}-point limit.`);
    }
    this.intelligenceAbort = new AbortController();
    const signal = this.intelligenceAbort.signal;
    await this.publishIntelligence({ phase: kind, currentAccountId: null, lastDecision: automatic ? "Automatic consolidation started after verified heist results." : kind === "CHECKING_POINTS" ? "Checking every selected account balance." : kind === "SWEEPING" ? "Consolidating verified balances into the bank account." : "Preparing a verified account-to-account transfer." });
    const work = kind === "CHECKING_POINTS" ? this.runPointsCheck(signal) : kind === "SWEEPING" ? this.runPointsSweep(signal) : this.runDirectTransfer(signal, transfer!);
    this.intelligenceTask = work.catch(async error => {
      if (signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      const reason = error instanceof Error ? error.message : "Points operation failed.";
      await this.publishIntelligence({ phase: reason === "HEIST_PRIORITY" ? "PAUSED_FOR_HEIST" : "ERROR", currentAccountId: null, lastDecision: reason === "HEIST_PRIORITY" ? "A new heist announcement took priority. Consolidation will wait." : reason });
      await activityLog({ action: "STREAMLABS_POINTS_ERROR", level: reason === "HEIST_PRIORITY" ? "WARNING" : "ERROR", status: "ERROR", message: reason === "HEIST_PRIORITY" ? "Points operation paused for a new heist announcement." : "Points operation failed.", errorMessage: reason });
    }).finally(async () => {
      this.intelligenceTask = undefined; this.intelligenceAbort = undefined;
      if (this.state.intelligence.phase !== "ERROR" && this.state.intelligence.phase !== "PAUSED_FOR_HEIST") await this.publishIntelligence({ phase: "IDLE", currentAccountId: null, lastOperationAt: new Date().toISOString() });
      if (standalone) {
        for (const account of this.participants) { const page = this.pages.get(account.id); if (page) await browserManager.closePage(account.id, page); }
        this.pages.clear();
      }
    });
    return this.snapshot();
  }

  async configure(config: StreamlabsConfig) {
    if (this.isRunning()) throw new Error("Pause or stop Streamlabs Mode before changing its settings.");
    const incoming: StreamlabsConfig = {
      ...defaults,
      ...config,
    };
    const parsed = parseYouTubeUrl(incoming.youtubeUrl);
    const clean: StreamlabsConfig = {
      youtubeUrl: parsed.canonicalUrl,
      accountIds: [...new Set(incoming.accountIds)],
      messages: [...new Set(incoming.messages.map(value => value.trim()).filter(Boolean))],
      delaySeconds: Math.max(1, Math.round(incoming.delaySeconds)),
      fallbackSeconds: Math.max(10, Math.round(incoming.fallbackSeconds)),
      noMessageRepeats: Boolean(incoming.noMessageRepeats),
      heistWager: Math.max(1, Math.round(incoming.heistWager)),
      bankAccountId: incoming.bankAccountId || null,
      bankPresenceMessage: incoming.bankPresenceMessage.trim().slice(0, 200) || ".",
      bankPresenceSeconds: Math.max(30, Math.round(incoming.bankPresenceSeconds)),
      protectedReserve: Math.max(0, Math.round(incoming.protectedReserve)),
      minimumTransfer: Math.max(1, Math.round(incoming.minimumTransfer)),
      maximumTransfer: Math.max(1, Math.round(incoming.maximumTransfer)),
      responseTimeoutSeconds: Math.max(10, Math.round(incoming.responseTimeoutSeconds)),
      autoConsolidate: Boolean(incoming.autoConsolidate),
    };
    if (!clean.accountIds.length) throw new Error("Select at least one connected Google account.");
    if (!clean.messages.length) throw new Error("Add at least one chat message.");
    if (clean.noMessageRepeats && clean.messages.length < clean.accountIds.length) throw new Error("Add at least one unique message per selected account when no repeats is enabled.");
    if (clean.bankAccountId && !clean.accountIds.includes(clean.bankAccountId)) throw new Error("The bank account must be one of the selected accounts.");
    if (clean.maximumTransfer < clean.minimumTransfer) throw new Error("Maximum transfer must be greater than or equal to minimum transfer.");
    const count = await db.googleAccount.count({ where: { id: { in: clean.accountIds }, status: "CONNECTED" } });
    if (count !== clean.accountIds.length) throw new Error("Every selected account must be connected.");
    await db.appSetting.upsert({ where: { key: "streamlabsConfig" }, create: { key: "streamlabsConfig", value: JSON.stringify(clean) }, update: { value: JSON.stringify(clean) } });
    await this.publish({ config: clean, reason: null });
    return this.snapshot();
  }

  async updateYouTubeUrl(youtubeUrl: string) {
    if (this.isRunning()) throw new Error("Pause or stop Streamlabs Mode before changing the livestream URL.");
    await this.load();
    const parsed = parseYouTubeUrl(youtubeUrl);
    const config = { ...this.state.config, youtubeUrl: parsed.canonicalUrl };
    await db.appSetting.upsert({ where: { key: "streamlabsConfig" }, create: { key: "streamlabsConfig", value: JSON.stringify(config) }, update: { value: JSON.stringify(config) } });
    await this.publish({ config, reason: null });
    await activityLog({ action: "STREAMLABS_URL_UPDATED", level: "SUCCESS", status: "COMPLETED", message: "Streamlabs livestream URL was updated." });
    return this.snapshot();
  }

  async start(config?: StreamlabsConfig) {
    if (config) await this.configure(config); else await this.load();
    if (this.state.enabled || this.task) throw new Error("Streamlabs Mode is already running.");
    if (this.intelligenceTask) throw new Error("Stop the active Points Bank operation before starting Streamlabs Mode.");
    const cfg = this.state.config;
    if (!cfg.youtubeUrl || !cfg.accountIds.length || !cfg.messages.length) throw new Error("Complete and save the Streamlabs settings first.");
    const accounts = await db.googleAccount.findMany({ where: { id: { in: cfg.accountIds }, status: "CONNECTED" } });
    const byId = new Map(accounts.map(account => [account.id, account]));
    this.participants = cfg.accountIds.map(id => byId.get(id)).filter((account): account is GoogleAccount => !!account);
    if (this.participants.length !== cfg.accountIds.length) throw new Error("Reconnect every selected account before starting Streamlabs Mode.");
    const missingHandle = this.participants.find(account => !this.usernameFor(account));
    if (missingHandle) throw new Error(`Reconnect ${missingHandle.displayName} so its YouTube channel handle can be detected.`);
    this.blocked.clear(); this.cooldown.clear(); this.failures.clear();
    this.intelligenceSeen.clear(); this.intelligenceSeeded = false; this.pendingAutoSweep = false;
    this.abort = new AbortController();
    await this.publish({ enabled: true, phase: "STARTING", reason: null, currentAccountId: null, nextActionAt: null, participants: this.participants.map(a => ({ id: a.id, name: a.displayName })) });
    this.task = this.run(this.abort.signal).catch(async error => {
      if (this.state.phase !== "ERROR") await this.publish({ enabled: false, phase: "ERROR", reason: error instanceof Error ? error.message : "Streamlabs worker failed.", currentAccountId: null, nextActionAt: null });
    }).finally(() => { this.task = undefined; });
    return this.snapshot();
  }

  async pause() { return this.finish("PAUSED", "Streamlabs Mode paused. Regular automations continue unchanged."); }
  async stop(reason = "Streamlabs Mode stopped.") { return this.finish("OFF", reason); }
  private async finish(phase: "PAUSED" | "OFF", reason: string) {
    this.intelligenceAbort?.abort(); this.abort?.abort(); await Promise.all([this.task?.catch(() => undefined), this.intelligenceTask?.catch(() => undefined)]); this.task = undefined; this.intelligenceTask = undefined;
    await this.publish({ enabled: false, phase, reason, currentAccountId: null, nextActionAt: null });
    await this.publishIntelligence({ phase: "IDLE", currentAccountId: null, lastDecision: "Streamlabs Mode stopped; points operations stopped too." });
    await activityLog({ action: phase === "PAUSED" ? "STREAMLABS_PAUSED" : "STREAMLABS_STOPPED", status: phase, message: reason });
    return this.snapshot();
  }

  private async pageFor(accountId: string, signal: AbortSignal) {
    let page = this.pages.get(accountId);
    if (!page || page.isClosed()) { page = await browserManager.newPage(accountId); this.pages.set(accountId, page); signal.throwIfAborted(); await page.goto(this.state.config.youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }); }
    return page;
  }

  private async claim(videoId: string, messageId: string) {
    try { await db.streamlabsTrigger.create({ data: { videoId, messageId } }); return true; }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") return false; throw error; }
  }

  private async run(signal: AbortSignal) {
    const cfg = this.state.config, source = this.participants[0], videoId = parseYouTubeUrl(cfg.youtubeUrl).videoId;
    const tracker = new AnnouncementTracker();
    let monitor: Page | undefined, roundTask: Promise<void> | undefined, roundError: unknown, queuedAnnouncement = false, monitorFailures = 0;
    let fallbackAt = Date.now() + cfg.fallbackSeconds * 1000;
    const closeOnAbort = () => { void monitor?.close().catch(() => undefined); for (const page of this.pages.values()) void page.close().catch(() => undefined); };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    const beginRound = async (trigger: "ANNOUNCEMENT" | "TIMER") => {
      fallbackAt = Date.now() + cfg.fallbackSeconds * 1000;
      await this.publish({ phase: "SENDING", round: this.state.round + 1, lastRoundTrigger: trigger, nextActionAt: null });
      roundTask = this.runRound(signal, trigger).catch(error => { roundError = error; }).finally(() => { fallbackAt = Date.now() + cfg.fallbackSeconds * 1000; roundTask = undefined; });
    };
    try {
      for (const account of this.participants) { signal.throwIfAborted(); try { await this.pageFor(account.id, signal); } catch (error) { if (!isTransientBrowserError(error)) throw error; this.pages.delete(account.id); } }
      await activityLog({ action: "STREAMLABS_STARTED", status: "LISTENING", message: `Streamlabs Mode started with ${this.participants.length} accounts. Regular automations continue independently.`, stream: cfg.youtubeUrl });
      while (!signal.aborted) {
        if (roundError) throw roundError;
        try {
          if (!monitor || monitor.isClosed()) { monitor = await browserManager.newPage(source.id); signal.throwIfAborted(); await monitor.goto(cfg.youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }); tracker.resetBaseline(); await this.delay(2000, signal); }
          const account = await detectAccountStatus(monitor);
          if (!account.authenticated && account.signedOut) throw new Error("Reconnect the monitoring account. It is signed out of YouTube.");
          const stream = await detectStreamStatus(monitor);
          if (stream.ended) throw new Error("The monitored livestream has ended.");
          if (!stream.active) { await this.publish({ phase: "RETRYING", reason: stream.reason ?? "Waiting for the livestream.", nextActionAt: new Date(Date.now() + 60_000).toISOString() }); await this.delay(60_000, signal); continue; }
          const messages = await readStreamlabsChat(monitor);
          if (messages === null) { const error = new Error("Live chat is still loading or unavailable."); error.name = "TimeoutError"; throw error; }
          monitorFailures = 0;
          for (const announcement of tracker.observe(messages)) {
            if (!await this.claim(videoId, announcement.id)) continue;
            this.announcementVersion++;
            await this.publish({ lastAnnouncementAt: new Date().toISOString() });
            if (roundTask) queuedAnnouncement = true; else await beginRound("ANNOUNCEMENT");
          }
          if (!roundTask && queuedAnnouncement) { queuedAnnouncement = false; await beginRound("ANNOUNCEMENT"); }
          else if (!roundTask && Date.now() >= fallbackAt) await beginRound("TIMER");
          else if (!roundTask && this.state.phase !== "LISTENING") await this.publish({ phase: "LISTENING", reason: null, nextActionAt: new Date(fallbackAt).toISOString() });
          if (!roundTask && !this.intelligenceTask && this.pendingAutoSweep) { this.pendingAutoSweep = false; await this.startIntelligenceOperation("SWEEPING", true); }
          await this.delay(750, signal);
        } catch (error) {
          if (signal.aborted || !isTransientBrowserError(error)) throw error;
          if (++monitorFailures > MAX_TRANSIENT_RETRIES) throw new Error("Streamlabs monitor could not recover after five delayed retries. Check the browser session.");
          const seconds = retryDelaySeconds(monitorFailures, 30);
          await this.publish({ phase: "RETRYING", reason: "Temporary chat-monitor failure; reconnecting after a delay.", nextActionAt: new Date(Date.now() + seconds * 1000).toISOString() });
          if (monitor) await browserManager.closePage(source.id, monitor); monitor = undefined;
          await this.delay(seconds * 1000, signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) { const reason = error instanceof Error ? error.message : "Streamlabs Mode failed."; await this.publish({ enabled: false, phase: "ERROR", reason, nextActionAt: null, currentAccountId: null }); await activityLog({ action: "STREAMLABS_ERROR", level: "ERROR", status: "ERROR", message: "Streamlabs Mode stopped. Regular automations were not changed.", errorMessage: reason }); }
    } finally {
      await roundTask; signal.removeEventListener("abort", closeOnAbort);
      if (monitor) await browserManager.closePage(source.id, monitor);
      for (const account of this.participants) { const page = this.pages.get(account.id); if (page) await browserManager.closePage(account.id, page); }
      this.pages.clear();
    }
  }

  private async observeIntelligence(messages: ChatAnnouncement[]) {
    const fresh: ChatAnnouncement[] = [];
    for (const message of messages) {
      if (!message.id || this.intelligenceSeen.has(message.id)) continue;
      this.intelligenceSeen.add(message.id);
      if (this.intelligenceSeeded && isStreamlabsMessage(message)) fresh.push(message);
    }
    this.intelligenceSeeded = true;
    if (this.intelligenceSeen.size > 5000) this.intelligenceSeen = new Set([...this.intelligenceSeen].slice(-2500));
    for (const message of fresh) await this.processIntelligenceMessage(message);
  }

  private async processIntelligenceMessage(message: ChatAnnouncement) {
    const balance = parsePointsBalance(message.text), roll = parseRoll(message.text), transfer = parseTransfer(message.text);
    const captain = parseHeistCaptain(message.text), joined = parseHeistJoin(message.text), results = parseHeistResults(message.text);
    if (balance) {
      const account = this.accountForUsername(balance.username);
      if (account) await this.recordBalance(account.id, balance.username, balance.balance, "POINTS", message.id);
    }
    if (roll) {
      const account = this.accountForUsername(roll.username);
      if (account) await this.recordBalance(account.id, roll.username, roll.balance, "ROLL", message.id);
    }
    if (transfer) {
      const donor = this.accountForUsername(transfer.donor), recipient = this.accountForUsername(transfer.recipient);
      const balances = { ...this.state.intelligence.balances };
      if (transfer.ok && donor && balances[donor.id]) balances[donor.id] = { ...balances[donor.id], balance: Math.max(0, balances[donor.id].balance - transfer.amount), verifiedAt: new Date().toISOString(), source: "TRANSFER", sourceMessageId: message.id };
      if (transfer.ok && recipient && balances[recipient.id]) balances[recipient.id] = { ...balances[recipient.id], balance: balances[recipient.id].balance + transfer.amount, verifiedAt: new Date().toISOString(), source: "TRANSFER", sourceMessageId: message.id };
      if (donor || recipient) await this.publishIntelligence({ balances });
    }
    if (captain) {
      const participant = this.accountForUsername(captain.username);
      await this.publishIntelligence({ activeHeist: { announcementId: message.id, captain: captain.username, startedAt: new Date().toISOString(), participantAccountIds: participant ? [participant.id] : [] }, lastDecision: "New Streamlabs heist detected; heist actions have priority." });
    }
    if (joined && this.state.intelligence.activeHeist) {
      const participant = this.accountForUsername(joined.username);
      if (participant && !this.state.intelligence.activeHeist.participantAccountIds.includes(participant.id)) {
        await this.publishIntelligence({ activeHeist: { ...this.state.intelligence.activeHeist, participantAccountIds: [...this.state.intelligence.activeHeist.participantAccountIds, participant.id] }, lastDecision: `${joined.username} was confirmed as a heist participant.` });
      }
    }
    if (results && this.state.intelligence.activeHeist) {
      const active = this.state.intelligence.activeHeist, cfg = this.state.config;
      const participantResults = active.participantAccountIds.map(accountId => {
        const account = this.participants.find(item => item.id === accountId)!;
        const username = this.usernameFor(account);
        const winner = results.winners.find(item => sameStreamlabsName(item.username, username));
        const payout = winner?.payout ?? 0;
        return { accountId, username, payout, net: payout - cfg.heistWager, outcome: winner ? "WON" as const : "LOST" as const };
      });
      const summary: StreamlabsHeistSummary = { announcementId: active.announcementId, startedAt: active.startedAt, completedAt: new Date().toISOString(), wager: cfg.heistWager, participants: participantResults, totalNet: participantResults.reduce((total, item) => total + item.net, 0), resultsMessageId: message.id };
      await this.publishIntelligence({ activeHeist: null, recentHeists: [summary, ...this.state.intelligence.recentHeists].slice(0, 50), lastDecision: `Heist results recorded: ${participantResults.filter(item => item.outcome === "WON").length} won, ${participantResults.filter(item => item.outcome === "LOST").length} lost, net ${summary.totalNet} points.` });
      if (cfg.autoConsolidate && cfg.bankAccountId) this.pendingAutoSweep = true;
    }
  }

  private async recordBalance(accountId: string, username: string, balance: number, source: StreamlabsBalance["source"], sourceMessageId: string) {
    await this.publishIntelligence({ balances: { ...this.state.intelligence.balances, [accountId]: { username, balance, verifiedAt: new Date().toISOString(), source, sourceMessageId } } });
  }

  private async currentRows(monitor: Page) {
    const rows = await readStreamlabsChat(monitor);
    if (!rows) throw new Error("Live chat is unavailable while waiting for Streamlabs.");
    return rows;
  }

  private async waitForNew<T>(monitor: Page, baseline: Set<string>, signal: AbortSignal, version: number, match: (message: ChatAnnouncement) => T | null, finishTransfer = false) {
    const deadline = Date.now() + this.state.config.responseTimeoutSeconds * 1000;
    let heistPriority = false;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const rows = await this.currentRows(monitor);
      for (const row of rows) {
        if (!row.id || baseline.has(row.id)) continue;
        if (isHeistAnnouncement(row)) heistPriority = true;
        const value = match(row);
        if (value !== null) return { row, value, heistPriority };
      }
      if (!finishTransfer && (heistPriority || this.announcementVersion !== version)) throw new Error("HEIST_PRIORITY");
      await this.delay(750, signal);
    }
    if (heistPriority || this.announcementVersion !== version) throw new Error("HEIST_PRIORITY");
    throw new Error("Streamlabs did not provide a matching confirmation before the response timeout.");
  }

  private async sendCommand(account: GoogleAccount, command: string, signal: AbortSignal) {
    await this.publishIntelligence({ currentAccountId: account.id });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await accountAccess.run(account.id, signal, () => this.pageFor(account.id, signal).then(page => sendChatMessage(page, this.state.config.youtubeUrl, command, signal, { prepared: true })));
      if (result.ok) return;
      // This response happens before the composer is used, so retrying once on
      // a fresh page is safe. Never retry post-send uncertainty automatically.
      if (attempt === 0 && result.retryable && result.reason === "Could not confirm the signed-in YouTube account while the page loaded.") {
        const page = this.pages.get(account.id);
        if (page) await browserManager.closePage(account.id, page);
        this.pages.delete(account.id);
        await this.delay(1500, signal);
        continue;
      }
      throw new Error(`${account.displayName}: ${result.reason ?? `YouTube did not accept ${command}.`}`);
    }
  }

  private async queryBalance(account: GoogleAccount, monitor: Page, signal: AbortSignal, version: number) {
    const username = this.usernameFor(account);
    if (!username) throw new Error(`Reconnect ${account.displayName} so its YouTube channel handle can be detected.`);
    const baseline = new Set((await this.currentRows(monitor)).map(row => row.id));
    await this.sendCommand(account, "!points", signal);
    const found = await this.waitForNew(monitor, baseline, signal, version, message => {
      if (!isStreamlabsMessage(message)) return null;
      const parsed = parsePointsBalance(message.text);
      return parsed && sameStreamlabsName(parsed.username, username) ? parsed : null;
    });
    await this.recordBalance(account.id, found.value.username, found.value.balance, "POINTS", found.row.id);
    await activityLog({ action: "STREAMLABS_POINTS_VERIFIED", level: "SUCCESS", status: "RUNNING", message: `${account.displayName} has ${found.value.balance} verified points.` });
    return found.value.balance;
  }

  private async operationMonitor(signal: AbortSignal) {
    const source = this.participants[0];
    if (!source) throw new Error("No connected monitoring account is available.");
    const monitor = await browserManager.newPage(source.id);
    signal.throwIfAborted();
    await monitor.goto(this.state.config.youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.delay(2000, signal);
    return { monitor, source };
  }

  private async runPointsCheck(signal: AbortSignal) {
    const version = this.announcementVersion, { monitor, source } = await this.operationMonitor(signal);
    try {
      for (const account of this.participants) {
        if (this.announcementVersion !== version) throw new Error("HEIST_PRIORITY");
        await this.queryBalance(account, monitor, signal, version);
        await this.delay(this.state.config.delaySeconds * 1000, signal);
      }
      await this.publishIntelligence({ lastDecision: "All selected account balances were verified successfully." });
    } finally { await browserManager.closePage(source.id, monitor); }
  }

  private async ensureRecipientPresence(recipient: GoogleAccount, monitor: Page, signal: AbortSignal, version: number) {
    await this.publishIntelligence({ phase: "PRIMING_BANK", currentAccountId: recipient.id, lastDecision: `Making ${recipient.displayName} visible to Streamlabs before transfers.` });
    const baseline = new Set((await this.currentRows(monitor)).map(row => row.id));
    await this.sendCommand(recipient, this.state.config.bankPresenceMessage, signal);
    await this.waitForNew(monitor, baseline, signal, version, message => sameStreamlabsName(message.author, this.usernameFor(recipient)) && message.text.trim() === this.state.config.bankPresenceMessage ? true : null);
    return Date.now();
  }

  private async runDirectTransfer(signal: AbortSignal, request: { fromAccountId: string; toAccountId: string; amount: number }) {
    const cfg = this.state.config;
    const donor = this.participants.find(account => account.id === request.fromAccountId);
    const recipient = this.participants.find(account => account.id === request.toAccountId);
    const amount = Math.round(request.amount);
    if (!donor || !recipient) throw new Error("Choose two connected Points Bank accounts.");
    if (donor.id === recipient.id) throw new Error("Sender and recipient must be different accounts.");
    if (!Number.isFinite(amount) || amount < 1) throw new Error("Transfer amount must be a positive whole number.");
    if (amount > cfg.maximumTransfer) throw new Error(`Transfer amount cannot exceed the configured ${cfg.maximumTransfer}-point limit.`);
    const recipientUsername = this.usernameFor(recipient), version = this.announcementVersion;
    const { monitor, source } = await this.operationMonitor(signal);
    try {
      await this.ensureRecipientPresence(recipient, monitor, signal, version);
      const balance = await this.queryBalance(donor, monitor, signal, version);
      if (balance - amount < cfg.protectedReserve) throw new Error(`${donor.displayName} must keep the configured ${cfg.protectedReserve}-point reserve.`);
      await this.publishIntelligence({ phase: "TRANSFERRING", currentAccountId: donor.id });
      const baseline = new Set((await this.currentRows(monitor)).map(row => row.id));
      await this.sendCommand(donor, `!give ${recipientUsername} ${amount}`, signal);
      let response;
      try {
        response = await this.waitForNew(monitor, baseline, signal, version, message => {
          if (!isStreamlabsMessage(message)) return null;
          const parsed = parseTransfer(message.text);
          return parsed && sameStreamlabsName(parsed.donor, this.usernameFor(donor)) && sameStreamlabsName(parsed.recipient, recipientUsername) && parsed.amount === amount ? parsed : null;
        }, true);
      } catch (error) {
        const record: StreamlabsTransferRecord = { id: `${Date.now()}-${donor.id}`, donorAccountId: donor.id, bankAccountId: recipient.id, donor: this.usernameFor(donor), recipient: recipientUsername, amount, status: "UNCERTAIN", createdAt: new Date().toISOString(), reason: error instanceof Error ? error.message : "Confirmation missing." };
        await this.publishIntelligence({ transfers: [record, ...this.state.intelligence.transfers].slice(0, 100), lastDecision: "Transfer delivery is uncertain. It will not be resent automatically." });
        throw new Error("A transfer confirmation was not received. No automatic resend was attempted.");
      }
      const record: StreamlabsTransferRecord = { id: `${Date.now()}-${donor.id}`, donorAccountId: donor.id, bankAccountId: recipient.id, donor: response.value.donor, recipient: response.value.recipient, amount, status: response.value.ok ? "CONFIRMED" : "FAILED", createdAt: new Date().toISOString(), responseMessageId: response.row.id, reason: response.value.ok ? undefined : "Streamlabs rejected the transfer." };
      await this.publishIntelligence({ transfers: [record, ...this.state.intelligence.transfers].slice(0, 100), lastDecision: response.value.ok ? `${amount} points transferred from ${record.donor} to ${record.recipient}.` : `Streamlabs rejected the transfer from ${record.donor}.` });
      await activityLog({ action: response.value.ok ? "STREAMLABS_TRANSFER_CONFIRMED" : "STREAMLABS_TRANSFER_FAILED", level: response.value.ok ? "SUCCESS" : "WARNING", status: response.value.ok ? "RUNNING" : "ERROR", message: response.value.ok ? `${record.donor} transferred ${amount} points to ${record.recipient}.` : `${record.donor}'s transfer was rejected by Streamlabs.` });
      if (!response.value.ok) return;
      if (response.heistPriority || this.announcementVersion !== version) throw new Error("HEIST_PRIORITY");
      await this.queryBalance(donor, monitor, signal, version);
      await this.queryBalance(recipient, monitor, signal, version);
    } finally { await browserManager.closePage(source.id, monitor); }
  }

  private async runPointsSweep(signal: AbortSignal) {
    const cfg = this.state.config, version = this.announcementVersion, bank = this.participants.find(account => account.id === cfg.bankAccountId);
    if (!bank) throw new Error("The configured bank account is not connected or is no longer selected.");
    const bankUsername = this.usernameFor(bank);
    if (!bankUsername) throw new Error("Reconnect the bank account so its YouTube channel handle can be detected.");
    const { monitor, source } = await this.operationMonitor(signal);
    let bankPresenceAt = 0;
    try {
      bankPresenceAt = await this.ensureRecipientPresence(bank, monitor, signal, version);
      await this.publishIntelligence({ phase: "SWEEPING" });
      for (const donor of this.participants.filter(account => account.id !== bank.id)) {
        if (this.announcementVersion !== version) throw new Error("HEIST_PRIORITY");
        let balance = await this.queryBalance(donor, monitor, signal, version);
        while (balance - cfg.protectedReserve >= cfg.minimumTransfer) {
          if (this.announcementVersion !== version) throw new Error("HEIST_PRIORITY");
          if (Date.now() - bankPresenceAt > cfg.bankPresenceSeconds * 1000) bankPresenceAt = await this.ensureRecipientPresence(bank, monitor, signal, version);
          await this.publishIntelligence({ phase: "SWEEPING", currentAccountId: donor.id });
          const amount = Math.min(cfg.maximumTransfer, balance - cfg.protectedReserve);
          const baseline = new Set((await this.currentRows(monitor)).map(row => row.id));
          await this.sendCommand(donor, `!give ${bankUsername} ${amount}`, signal);
          let response;
          try {
            response = await this.waitForNew(monitor, baseline, signal, version, message => {
              if (!isStreamlabsMessage(message)) return null;
              const parsed = parseTransfer(message.text);
              return parsed && sameStreamlabsName(parsed.donor, this.usernameFor(donor)) && sameStreamlabsName(parsed.recipient, bankUsername) && parsed.amount === amount ? parsed : null;
            }, true);
          } catch (error) {
            const record: StreamlabsTransferRecord = { id: `${Date.now()}-${donor.id}`, donorAccountId: donor.id, bankAccountId: bank.id, donor: this.usernameFor(donor), recipient: bankUsername, amount, status: "UNCERTAIN", createdAt: new Date().toISOString(), reason: error instanceof Error ? error.message : "Confirmation missing." };
            await this.publishIntelligence({ transfers: [record, ...this.state.intelligence.transfers].slice(0, 100), lastDecision: "Transfer delivery is uncertain. It will not be resent until balances are checked manually." });
            throw new Error("A transfer confirmation was not received. No automatic resend was attempted.");
          }
          const record: StreamlabsTransferRecord = { id: `${Date.now()}-${donor.id}`, donorAccountId: donor.id, bankAccountId: bank.id, donor: response.value.donor, recipient: response.value.recipient, amount, status: response.value.ok ? "CONFIRMED" : "FAILED", createdAt: new Date().toISOString(), responseMessageId: response.row.id, reason: response.value.ok ? undefined : "Streamlabs rejected the transfer." };
          await this.publishIntelligence({ transfers: [record, ...this.state.intelligence.transfers].slice(0, 100), lastDecision: response.value.ok ? `${amount} points transferred from ${record.donor} to ${record.recipient}.` : `Streamlabs rejected the transfer from ${record.donor}.` });
          await activityLog({ action: response.value.ok ? "STREAMLABS_TRANSFER_CONFIRMED" : "STREAMLABS_TRANSFER_FAILED", level: response.value.ok ? "SUCCESS" : "WARNING", status: response.value.ok ? "RUNNING" : "ERROR", message: response.value.ok ? `${record.donor} transferred ${amount} points to ${record.recipient}.` : `${record.donor}'s transfer was rejected by Streamlabs.` });
          if (!response.value.ok) break;
          if (response.heistPriority || this.announcementVersion !== version) throw new Error("HEIST_PRIORITY");
          await this.delay(cfg.delaySeconds * 1000, signal);
          balance = await this.queryBalance(donor, monitor, signal, version);
        }
      }
      await this.queryBalance(bank, monitor, signal, version);
      await this.publishIntelligence({ lastDecision: "Point consolidation completed and the bank balance was verified." });
    } finally { await browserManager.closePage(source.id, monitor); }
  }

  private async runRound(signal: AbortSignal, trigger: "ANNOUNCEMENT" | "TIMER") {
    const cfg = this.state.config, accounts = shuffle(this.participants.filter(account => !this.blocked.has(account.id))), messageOrder = cfg.noMessageRepeats ? shuffle(cfg.messages) : [];
    let lastAttemptAt = 0;
    for (let index = 0; index < accounts.length; index++) {
      const account = accounts[index]; signal.throwIfAborted();
      if ((this.cooldown.get(account.id) ?? 0) > Date.now()) { await activityLog({ action: "STREAMLABS_COOLDOWN", level: "WARNING", status: "RATE_LIMITED", message: `${account.displayName} skipped this round because its cooldown is active.` }); continue; }
      const wait = Math.max(0, lastAttemptAt + cfg.delaySeconds * 1000 - Date.now());
      if (wait) { await this.publish({ currentAccountId: account.id, nextActionAt: new Date(Date.now() + wait).toISOString() }); await this.delay(wait, signal); }
      const message = cfg.noMessageRepeats && index < messageOrder.length ? messageOrder[index] : cfg.messages[Math.floor(Math.random() * cfg.messages.length)];
      await this.publish({ currentAccountId: account.id, nextActionAt: null });
      let result: ChatResult;
      try {
        result = await accountAccess.run(account.id, signal, async () => {
          const current = await db.googleAccount.findUniqueOrThrow({ where: { id: account.id } });
          if (current.status !== "CONNECTED") return { ok: false, status: "AUTH_REQUIRED", reason: "Reconnect this account." } satisfies ChatResult;
          return sendChatMessage(await this.pageFor(account.id, signal), cfg.youtubeUrl, message, signal, { prepared: true });
        });
      } catch (error) { if (signal.aborted) throw error; result = { ok: false, status: "ERROR", retryable: isTransientBrowserError(error), reason: error instanceof Error ? error.message : "Send failed." }; }
      lastAttemptAt = Date.now();
      if (result.ok) {
        this.failures.delete(account.id);
        await activityLog({ action: "STREAMLABS_MESSAGE_SENT", level: "SUCCESS", status: "RUNNING", message: `Round ${this.state.round}: ${account.displayName} sent “${message}”.`, stream: cfg.youtubeUrl });
      } else {
        const reason = result.reason ?? "YouTube did not accept the message.", failures = result.retryable ? (this.failures.get(account.id) ?? 0) + 1 : 0;
        if (result.retryable) this.failures.set(account.id, failures);
        const retry = result.status === "RATE_LIMITED" || result.status === "WAITING_FOR_STREAM" || (result.retryable && failures <= MAX_TRANSIENT_RETRIES);
        if (retry) {
          const seconds = Math.max(result.retryAfterSeconds ?? 60, retryDelaySeconds(Math.max(1, failures), 30)); this.cooldown.set(account.id, Date.now() + seconds * 1000);
          await activityLog({ action: "STREAMLABS_SEND_DEFERRED", level: "WARNING", status: "WAITING_FOR_TRIGGER", message: `${account.displayName} will not resend in this round.`, errorMessage: reason });
          const page = this.pages.get(account.id); if (page) await browserManager.closePage(account.id, page); this.pages.delete(account.id);
        } else { this.blocked.add(account.id); await activityLog({ action: "STREAMLABS_ACCOUNT_BLOCKED", level: "ERROR", status: result.status, message: `${account.displayName} was removed from Streamlabs Mode until it is restarted.`, errorMessage: reason }); }
      }
    }
    if (this.blocked.size === this.participants.length) throw new Error("No selected account can send. Check the Streamlabs logs before restarting.");
    await this.publish({ phase: "LISTENING", currentAccountId: null, nextActionAt: new Date(Date.now() + cfg.fallbackSeconds * 1000).toISOString() });
    await activityLog({ action: "STREAMLABS_ROUND_COMPLETE", status: "WAITING_FOR_TRIGGER", message: `Round ${this.state.round} (${trigger.toLowerCase()}) finished. Waiting for an announcement; timer fallback remains active.` });
  }
}
