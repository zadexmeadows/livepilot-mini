import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { db } from "@/lib/db/client";

type ManagedContext = { context: BrowserContext; pages: Set<Page>; controlPage?: Page };
const globalBrowserState = globalThis as unknown as {
  managedBrowserContexts?: Map<string, ManagedContext>;
  browserContextLaunches?: Map<string, Promise<BrowserContext>>;
  manualBrowserProcesses?: Map<string, ChildProcess>;
  manualBrowserLaunches?: Map<string, Promise<void>>;
};

class BrowserManager {
  private contexts = globalBrowserState.managedBrowserContexts ?? new Map<string, ManagedContext>();
  private launches = globalBrowserState.browserContextLaunches ?? new Map<string, Promise<BrowserContext>>();
  private manual = globalBrowserState.manualBrowserProcesses ?? new Map<string, ChildProcess>();
  private manualLaunches = globalBrowserState.manualBrowserLaunches ?? new Map<string, Promise<void>>();

  constructor() {
    globalBrowserState.managedBrowserContexts = this.contexts;
    globalBrowserState.browserContextLaunches = this.launches;
    globalBrowserState.manualBrowserProcesses = this.manual;
    globalBrowserState.manualBrowserLaunches = this.manualLaunches;
  }

  private async options() {
    const rows = await db.appSetting.findMany({ where: { key: { in: ["browserExecutablePath", "runBrowserMinimized"] } } });
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const executablePath = settings.browserExecutablePath?.trim();
    const configuredChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL?.trim();
    if (executablePath && !fs.existsSync(executablePath)) throw new Error("The configured browser executable path does not exist.");
    return {
      headless: false as const,
      chromiumSandbox: true,
      timeout: 45_000,
      executablePath: executablePath || undefined,
      channel: executablePath ? undefined : configuredChannel || undefined,
      viewport: null,
      args: settings.runBrowserMinimized === "true" ? ["--start-minimized"] : [],
      locale: "en-US",
    };
  }

  async getContext(accountId: string) {
    if (this.isManualSignIn(accountId)) throw new Error("Finish manual sign-in and close that Chrome window before using automation.");
    const existing = this.contexts.get(accountId);
    if (existing) return existing.context;
    const pending = this.launches.get(accountId);
    if (pending) return pending;
    const launch = this.launchContext(accountId).finally(() => this.launches.delete(accountId));
    this.launches.set(accountId, launch);
    return launch;
  }

  private async launchContext(accountId: string) {
    const account = await db.googleAccount.findUniqueOrThrow({ where: { id: accountId } });
    const profileDirectory = path.resolve(/* turbopackIgnore: true */ account.profileDirectory);
    fs.mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(profileDirectory, await this.options());
    const managed = { context, pages: new Set<Page>(), controlPage: context.pages()[0] };
    this.contexts.set(accountId, managed);
    context.on("close", () => this.contexts.delete(accountId));
    return context;
  }

  async newPage(accountId: string) {
    const context = await this.getContext(accountId);
    const page = await context.newPage();
    this.contexts.get(accountId)?.pages.add(page);
    page.on("close", () => this.contexts.get(accountId)?.pages.delete(page));
    await db.googleAccount.update({ where: { id: accountId }, data: { lastUsedAt: new Date() } });
    return page;
  }

  async currentPage(accountId: string) {
    const context = await this.getContext(accountId);
    const managed = this.contexts.get(accountId)!;
    const page = managed.controlPage && !managed.controlPage.isClosed() ? managed.controlPage : await context.newPage();
    managed.controlPage = page;
    await page.bringToFront();
    return page;
  }

  async openAccountSession(accountId: string, url?: string) {
    const page = await this.currentPage(accountId);
    if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    return page;
  }

  isManualSignIn(accountId: string) {
    return this.manual.has(accountId) || this.manualLaunches.has(accountId);
  }

  async openManualSignIn(accountId: string) {
    const pending = this.manualLaunches.get(accountId);
    if (pending) return pending;
    if (this.manual.has(accountId)) return;
    const launch = this.launchManualSignIn(accountId).finally(() => this.manualLaunches.delete(accountId));
    this.manualLaunches.set(accountId, launch);
    return launch;
  }

  private async launchManualSignIn(accountId: string) {
    // A profile has exactly one owner: either a manual browser or Playwright.
    const pending = this.launches.get(accountId);
    if (pending) await pending;
    const managed = this.contexts.get(accountId);
    if (managed?.pages.size) throw new Error("Pause all automations using this account before reconnecting.");
    if (managed) await managed.context.close();
    const account = await db.googleAccount.findUniqueOrThrow({ where: { id: accountId } });
    const options = await this.options();
    const candidates = [
      options.executablePath,
      process.env.MANUAL_BROWSER_EXECUTABLE,
      process.platform === "win32" ? path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe") : undefined,
      process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe") : undefined,
      process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
      chromium.executablePath(),
    ];
    const executable = candidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (!executable) throw new Error("Install Google Chrome or configure its executable path in Settings.");
    const profileDirectory = path.resolve(/* turbopackIgnore: true */ account.profileDirectory);
    fs.mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    // Normal, sandboxed browser: no automation, debugging, stealth or security-disabling flags.
    // shell:false keeps user-controlled paths out of shell command parsing.
    const child = spawn(executable, [
      `--user-data-dir=${profileDirectory}`, "--new-window", "https://www.youtube.com/",
    ], { shell: false, stdio: "ignore", windowsHide: false });
    this.manual.set(accountId, child);
    const cleanup = () => { if (this.manual.get(accountId) === child) this.manual.delete(accountId); };
    child.once("exit", cleanup);
    child.once("error", cleanup);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { clear(); resolve(); }, 1800);
      const onError = () => { clear(); reject(new Error("Could not launch manual Chrome. Check the executable path and browser sandbox configuration.")); };
      const onExit = () => { clear(); reject(new Error("Chrome closed during startup. Check the browser console for a profile-lock or sandbox error.")); };
      const clear = () => { clearTimeout(timer); child.off("error", onError); child.off("exit", onExit); };
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  async closePage(accountId: string, page: Page) {
    this.contexts.get(accountId)?.pages.delete(page);
    await page.close().catch(() => undefined);
  }

  async closeContext(accountId: string) {
    if (this.isManualSignIn(accountId)) throw new Error("Close the manual Chrome window before disconnecting or deleting this account.");
    const managed = this.contexts.get(accountId);
    if (!managed) return;
    this.contexts.delete(accountId);
    await managed.context.close().catch(() => undefined);
  }

  async closeAll() {
    await Promise.all([...this.contexts.keys()].map((id) => this.closeContext(id)));
  }

  isRunning(accountId?: string) {
    return accountId ? this.contexts.has(accountId) || this.isManualSignIn(accountId) : this.contexts.size + this.manual.size > 0;
  }

  activeContextCount() { return this.contexts.size + this.manual.size; }
}

export const browserManager = new BrowserManager();
