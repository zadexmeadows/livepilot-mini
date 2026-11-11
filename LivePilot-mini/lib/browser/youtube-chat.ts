import type { Frame, Locator, Page } from "playwright";
import { youtubeSelectors } from "./selectors";

export type ChatResult = {
  ok: boolean;
  status: "SENT" | "WAITING_FOR_STREAM" | "RATE_LIMITED" | "AUTH_REQUIRED" | "ERROR";
  reason?: string;
  retryAfterSeconds?: number;
  retryable?: boolean;
  streamTitle?: string;
  channelName?: string;
};

export function parseYouTubeUrl(value: string) {
  const url = new URL(value);
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname.toLowerCase())) {
    throw new Error("Enter a valid youtube.com live stream URL.");
  }
  let videoId = url.hostname === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v");
  if (!videoId && url.pathname.startsWith("/live/")) videoId = url.pathname.split("/")[2];
  if (!videoId || !/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) throw new Error("The YouTube URL does not contain a valid video ID.");
  return { videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

async function firstVisible(root: Page | Frame, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const matches = root.locator(selector);
    for (let index = 0; index < Math.min(await matches.count().catch(() => 0), 20); index++) {
      const locator = matches.nth(index);
      if (await locator.isVisible().catch(() => false)) return locator;
    }
  }
  return null;
}

export async function findLiveChatFrame(page: Page): Promise<Page | Frame | null> {
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    try {
      const url = new URL(frame.url());
      if (["www.youtube.com", "youtube.com"].includes(url.hostname) && url.pathname === "/live_chat") return frame;
    } catch { /* An iframe may still be about:blank while loading. */ }
  }
  let iframe = await firstVisible(page, youtubeSelectors.chatIframes);
  if (!iframe) {
    const openButton = await firstVisible(page, youtubeSelectors.chatOpenButtons);
    if (openButton) {
      await openButton.click({ timeout: 1000 }).catch(() => undefined);
      iframe = await firstVisible(page, youtubeSelectors.chatIframes);
    }
  }
  if (!iframe) return await firstVisible(page, youtubeSelectors.chatContainers) ? page : null;
  const handle = await iframe.elementHandle().catch(() => null);
  return handle ? await handle.contentFrame().catch(() => null) : null;
}

export async function findChatInput(root: Page | Frame): Promise<Locator | null> {
  // On the watch page, stay inside the live-chat container, never a search or comment box.
  const scope = "frames" in root ? root.locator(youtubeSelectors.chatContainers.join(",")) : root;
  const candidates = [
    scope.getByRole("textbox", { name: youtubeSelectors.chatInputName }),
    scope.getByPlaceholder(youtubeSelectors.chatInputPlaceholder),
    ...youtubeSelectors.chatInputs.map((selector) => scope.locator(selector)),
  ];
  for (const matches of candidates) {
    for (let index = 0; index < Math.min(await matches.count().catch(() => 0), 20); index++) {
      const input = matches.nth(index);
      if (await input.isVisible().catch(() => false) && await input.isEditable({ timeout: 500 }).catch(() => false)) return input;
    }
  }
  return null;
}

export type ChatWaitOptions = { timeoutMs?: number; pollMs?: number; signal?: AbortSignal };

function waitForNextCheck(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function readChatNotices(root: Page | Frame) {
  // Do not classify other viewers' messages as platform restrictions.
  const parts: string[] = [];
  for (const selector of youtubeSelectors.restrictionText) {
    const matches = root.locator(selector);
    for (let index = 0; index < Math.min(await matches.count().catch(() => 0), 10); index++) {
      const notice = matches.nth(index);
      if (await notice.isVisible().catch(() => false)) parts.push(await notice.innerText({ timeout: 500 }).catch(() => ""));
    }
  }
  return parts.join("\n").slice(-12000);
}

export async function waitForChatReady(page: Page, options: ChatWaitOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const deadline = Date.now() + timeoutMs;
  let foundChat = false;
  // Always assess once at the deadline, including when the polling timer runs late.
  for (;;) {
    options.signal?.throwIfAborted();
    if (page.isClosed()) throw new Error("The automation browser page was closed.");
    // Reacquire each time: YouTube can replace the iframe during initialization.
    const root = await findLiveChatFrame(page);
    foundChat ||= !!root;
    const notices = await readChatNotices(root ?? page);
    const input = root ? await findChatInput(root) : null;
    // A participation-mode banner is shown to eligible viewers too. Let the
    // composer initialize before interpreting a missing input as a restriction.
    const restriction = classifyRestriction(notices, !!input, Date.now() >= deadline);
    if (restriction) return { root, input: null, failure: restriction };
    const slow = parseSlowMode(notices);
    if (slow && /wait|remaining/i.test(notices)) {
      return { root, input: null, failure: { ok: false, status: "RATE_LIMITED", retryAfterSeconds: slow, reason: `YouTube slow mode requires waiting ${slow} seconds.` } satisfies ChatResult };
    }
    if (root && input) return { root, input, failure: null };
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await waitForNextCheck(Math.min(options.pollMs ?? 250, remaining), options.signal);
  }
  options.signal?.throwIfAborted();
  return { root: null, input: null, failure: {
    ok: false, status: "ERROR", retryable: true,
    reason: foundChat
      ? `Live chat loaded, but no editable message box appeared within ${Math.ceil(timeoutMs / 1000)} seconds. Check the chat panel for an access restriction or a changed YouTube layout.`
      : `Live chat did not become available within ${Math.ceil(timeoutMs / 1000)} seconds. It may be disabled or still loading.`,
  } satisfies ChatResult };
}

export async function detectSlowMode(root: Page | Frame) {
  return parseSlowMode(await readChatNotices(root));
}

function parseSlowMode(text: string) {
  const slow = text.match(/slow mode[^\d]*(\d+)\s*(seconds?|minutes?)/i);
  if (!slow) return null;
  const value = Number(slow[1]);
  return slow[2].toLowerCase().startsWith("minute") ? value * 60 : value;
}

export async function detectStreamStatus(page: Page) {
  // Restrict status detection to YouTube's player/info areas. A viewer's chat
  // message or a recommended video title must not mark this stream as ended.
  const parts: string[] = [];
  for (const selector of youtubeSelectors.streamStatus) {
    const notice = page.locator(selector).first();
    if (await notice.isVisible().catch(() => false)) parts.push(await notice.innerText({ timeout: 500 }).catch(() => ""));
  }
  const text = parts.join("\n");
  if (/this live stream (has ended|recording is not available)|streamed live on/i.test(text)) return { active: false, ended: true, reason: "The livestream has ended." };
  if (/waiting for .+ to go live|premieres in|scheduled for/i.test(text)) return { active: false, ended: false, reason: "The livestream has not started yet." };
  return { active: true, ended: false };
}

export async function detectAccountStatus(page: Page) {
  const signIn = await firstVisible(page, youtubeSelectors.signIn);
  if (signIn) return { authenticated: false, signedOut: true, reason: "The browser session is signed out." };
  const avatar = await firstVisible(page, youtubeSelectors.accountButton);
  return avatar ? { authenticated: true } : { authenticated: false, signedOut: false, reason: "Could not confirm the signed-in YouTube account while the page loaded." };
}

export async function waitForSendConfirmation(root: Page | Frame, input: Locator, options: ChatWaitOptions & { settleMs?: number } = {}): Promise<ChatResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  // Give asynchronous rejection toasts time to appear, even when the input clears.
  await waitForNextCheck(Math.min(options.settleMs ?? 1000, options.timeoutMs ?? 10_000), options.signal);
  for (;;) {
    options.signal?.throwIfAborted();
    const toastText = await Promise.all(youtubeSelectors.toast.map(async (selector) => {
      const locator = root.locator(selector).last();
      return await locator.isVisible().catch(() => false) ? await locator.textContent({ timeout: 500 }).catch(() => "") : "";
    })).then((values) => values.join(" ").trim());
    // Only platform toasts are inspected here, not the draft or viewers' messages.
    const restriction = classifyRestriction(toastText, false, true);
    if (restriction) return restriction;
    if (/spam|message (?:was )?(?:rejected|blocked|removed)|not allowed|inappropriate|too long/i.test(toastText)) {
      return { ok: false, status: "ERROR", reason: toastText };
    }
    if (/too many|slow mode|try again in \d+/i.test(toastText)) {
      const wait = toastText.match(/(?:wait|try again in)\s+(\d+)\s*(seconds?|minutes?)/i);
      const seconds = wait ? Number(wait[1]) * (wait[2].toLowerCase().startsWith("minute") ? 60 : 1) : null;
      return { ok: false, status: "RATE_LIMITED", reason: toastText, retryAfterSeconds: parseSlowMode(toastText) ?? seconds ?? 120 };
    }
    if (/not sent|failed|try again|something went wrong|network error/i.test(toastText)) {
      return { ok: false, status: "ERROR", retryable: true, reason: toastText };
    }
    const remaining = await input.inputValue({ timeout: 500 })
      .catch(() => input.textContent({ timeout: 500 }).catch(() => null));
    // A detached/unreadable input is not evidence of successful submission.
    if (remaining !== null && remaining.trim() === "" && await input.isVisible().catch(() => false)) {
      return { ok: true, status: "SENT" };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await waitForNextCheck(Math.min(options.pollMs ?? 250, remainingMs), options.signal);
  }
  return { ok: false, status: "ERROR", retryable: true, reason: "YouTube did not confirm submission within 10 seconds. Delivery is uncertain; no immediate resend will be attempted." };
}

async function pageMetadata(page: Page) {
  const titleLocator = await firstVisible(page, youtubeSelectors.videoTitle);
  const channelLocator = await firstVisible(page, youtubeSelectors.channelName);
  return {
    streamTitle: titleLocator ? (await titleLocator.textContent().catch(() => null))?.trim() : undefined,
    channelName: channelLocator ? (await channelLocator.textContent().catch(() => null))?.trim() : undefined,
  };
}

function classifyRestriction(text: string, hasEditableInput: boolean, readinessExpired: boolean): ChatResult | null {
  if (/captcha|verify (?:you are|your identity)|unusual traffic|account (?:suspended|disabled)|you (?:have been|are) (?:blocked|banned|timed out)/i.test(text)) return { ok: false, status: "ERROR", reason: "YouTube requires manual attention or has restricted this account. Check the browser session; automation will not bypass this restriction." };
  if (/live chat is disabled|chat is disabled|chat replay is disabled/i.test(text)) return { ok: false, status: "ERROR", reason: "Live chat is disabled for this stream." };
  if (/sign in to chat|sign in/i.test(text)) return { ok: false, status: "AUTH_REQUIRED", reason: "Sign in is required to use live chat." };
  // Explicit account-directed denials remain blocking even if a stale input is
  // still editable. Merely naming the chat mode does not establish ineligibility.
  const denied = /you (?:cannot|can['’]t|may not) (?:send|post|chat)|you are not (?:eligible|allowed)|you (?:must|need to) (?:subscribe|be subscribed|be a member|join)|subscribe to (?:this channel to )?(?:send|chat)|join (?:this|the) channel to (?:send|chat)/i.test(text);
  if (denied || (!hasEditableInput && readinessExpired)) {
    if (/members[- ]only|only (?:channel )?members|be a member|join (?:this|the) channel/i.test(text)) return { ok: false, status: "ERROR", reason: "YouTube has not enabled the message box for this members-only chat. Check the selected account's membership and the notice in its browser session." };
    if (/subscribers[- ]only|only (?:channel )?subscribers|subscrib/i.test(text)) return { ok: false, status: "ERROR", reason: "YouTube has not enabled the message box for this subscribers-only chat. Check the selected account and any subscription-duration requirement shown in its browser session." };
    if (denied) return { ok: false, status: "ERROR", reason: "YouTube reports that the selected account cannot post in this chat. Check the notice in its browser session." };
  }
  return null;
}

export async function sendChatMessage(page: Page, youtubeUrl: string, message: string, signal?: AbortSignal, options: { prepared?: boolean } = {}): Promise<ChatResult> {
  signal?.throwIfAborted();
  if (!options.prepared || page.url() !== youtubeUrl) {
    await page.goto(youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitForNextCheck(1800, signal);
  }
  const metadata = await pageMetadata(page);
  const account = await detectAccountStatus(page);
  if (!account.authenticated) return { ok: false, status: account.signedOut ? "AUTH_REQUIRED" : "ERROR", retryable: !account.signedOut, reason: account.reason, ...metadata };

  const stream = await detectStreamStatus(page);
  if (!stream.active) return { ok: false, status: stream.ended ? "ERROR" : "WAITING_FOR_STREAM", reason: stream.reason, ...metadata };

  const ready = await waitForChatReady(page, { signal });
  if (ready.failure) return { ...ready.failure, ...metadata };
  const { root, input } = ready;
  if (!root || !input) throw new Error("Chat readiness did not return an editable input.");
  const rootText = await readChatNotices(root);
  const slowModeSeconds = await detectSlowMode(root);

  if (slowModeSeconds && /wait|seconds remaining|minutes remaining/i.test(rootText)) {
    return { ok: false, status: "RATE_LIMITED", retryAfterSeconds: slowModeSeconds, reason: `YouTube slow mode is active. Waiting ${slowModeSeconds} seconds.`, ...metadata };
  }

  signal?.throwIfAborted();
  await input.click({ timeout: 5000 });
  signal?.throwIfAborted();
  await input.fill(message, { timeout: 5000 });
  signal?.throwIfAborted();
  await input.press("Enter", { timeout: 5000 });
  return { ...await waitForSendConfirmation(root, input, { signal }), ...metadata };
}
