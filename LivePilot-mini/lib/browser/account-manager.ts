import path from "node:path";
import { db } from "@/lib/db/client";
import { browserManager } from "./browser-manager";
import { youtubeSelectors } from "./selectors";
import { activityLog } from "@/lib/logger/activity-logger";
import { emitDashboardEvent } from "@/lib/events";

async function dataDirectory() {
  const setting = await db.appSetting.findUnique({ where: { key: "dataDirectory" } });
  return path.resolve(/* turbopackIgnore: true */ setting?.value || process.env.APP_DATA_DIR || "./data");
}

export async function connectGoogleAccount() {
  const id = `account_${Date.now().toString(36)}`;
  const profileDirectory = path.join(await dataDirectory(), "browser-profiles", id);
  const account = await db.googleAccount.create({ data: { id, profileDirectory, status: "CONNECTING" } });
  try {
    await browserManager.openManualSignIn(account.id);
    await activityLog({ action: "ACCOUNT_CONNECT", message: "Manual Chrome opened without automation. Sign in to YouTube, then close that Chrome window so the saved session can be checked." });
    emitDashboardEvent("account.connecting", account);
    return account;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not launch the browser.";
    await db.googleAccount.update({ where: { id }, data: { status: "ERROR", displayName: "Connection failed" } });
    throw new Error(message);
  }
}

const checkState = globalThis as unknown as { accountChecks?: Map<string, ReturnType<typeof inspectGoogleAccount>> };
const accountChecks = checkState.accountChecks ??= new Map();

export async function checkGoogleAccount(accountId: string) {
  const pending = accountChecks.get(accountId);
  if (pending) return pending;
  const check = inspectGoogleAccount(accountId).finally(() => accountChecks.delete(accountId));
  accountChecks.set(accountId, check);
  return check;
}

async function inspectGoogleAccount(accountId: string) {
  // Never attach automation, read login fields, or interrupt manual authentication.
  const existingAccount = await db.googleAccount.findUniqueOrThrow({ where: { id: accountId }, include: { _count: { select: { automations: true } } } });
  if (browserManager.isManualSignIn(accountId)) return existingAccount;
  if (existingAccount.status === "CONNECTING") await browserManager.openAccountSession(accountId, "https://www.youtube.com/");
  const page = await browserManager.currentPage(accountId);
  if (/accounts\.google\.com/.test(page.url())) return db.googleAccount.findUniqueOrThrow({ where: { id: accountId }, include: { _count: { select: { automations: true } } } });
  if (!/youtube\.com/.test(page.url())) await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1200);

  const markAuthRequired = async () => {
    const existing = await db.googleAccount.findUniqueOrThrow({ where: { id: accountId } });
    const falsePositive = existing.displayName === "Connected Google account";
    return db.googleAccount.update({
      where: { id: accountId },
      data: {
        status: "AUTH_REQUIRED",
        ...(falsePositive ? { displayName: "Google sign-in required", email: null, channelName: null, avatarUrl: null, connectedAt: null } : {}),
      },
      include: { _count: { select: { automations: true } } },
    });
  };

  for (const selector of youtubeSelectors.signIn) {
    if (await page.locator(selector).first().isVisible({ timeout: 400 }).catch(() => false)) return markAuthRequired();
  }

  let avatarButton = null;
  for (const selector of youtubeSelectors.accountButton) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible({ timeout: 700 }).catch(() => false)) { avatarButton = candidate; break; }
  }
  if (!avatarButton) return markAuthRequired();
  await avatarButton.click().catch(() => undefined);
  await page.waitForTimeout(900);
  let headerText = "";
  let avatarUrl: string | null = null;
  let authenticatedHeaderFound = false;
  for (const selector of youtubeSelectors.accountHeader) {
    const header = page.locator(selector).first();
    if (await header.isVisible({ timeout: 900 }).catch(() => false)) {
      authenticatedHeaderFound = true;
      headerText = await header.innerText().catch(() => "");
      avatarUrl = await header.locator("img").first().getAttribute("src").catch(() => null);
      break;
    }
  }

  if (!authenticatedHeaderFound) return markAuthRequired();

  const firstText = async (selectors: readonly string[]) => {
    for (const selector of selectors) {
      const value = (await page.locator(selector).first().textContent({ timeout: 500 }).catch(() => null))?.trim();
      if (value) return value;
    }
    return null;
  };

  const lines = headerText.split("\n").map((line) => line.trim()).filter(Boolean);
  const explicitEmail = await firstText(youtubeSelectors.accountEmail);
  const email = explicitEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(explicitEmail) ? explicitEmail : lines.find((line) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) ?? null;
  const handle = await firstText(youtubeSelectors.accountHandle) ?? lines.find((line) => /^@[\w.-]+$/.test(line)) ?? null;
  const explicitName = await firstText(youtubeSelectors.accountName);
  const displayName = explicitName ?? lines.find((line) => line !== email && line !== handle && !/manage your/i.test(line)) ?? null;

  if (!displayName && !email && !handle) return markAuthRequired();

  const resolvedName = displayName ?? handle ?? email!;
  const account = await db.googleAccount.update({
    where: { id: accountId },
    data: { displayName: resolvedName, email, channelName: handle ?? resolvedName, avatarUrl, status: "CONNECTED", connectedAt: new Date(), lastUsedAt: new Date() },
    include: { _count: { select: { automations: true } } },
  });
  await activityLog({ level: "SUCCESS", action: "ACCOUNT_CONNECTED", message: `${resolvedName} connected successfully.` });
  emitDashboardEvent("account.connected", account);
  return account;
}

export async function disconnectGoogleAccount(accountId: string) {
  await browserManager.closeContext(accountId);
  const account = await db.googleAccount.update({ where: { id: accountId }, data: { status: "DISCONNECTED" } });
  emitDashboardEvent("account.disconnected", account);
  return account;
}
