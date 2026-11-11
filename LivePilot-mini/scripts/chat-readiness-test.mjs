// Offline regression tests: no browser sessions, credentials or network requests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../lib/browser/", import.meta.url);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const selectorsUrl = asModule(compile(await readFile(new URL("selectors.ts", sourceUrl), "utf8")));
const chatCode = compile(await readFile(new URL("youtube-chat.ts", sourceUrl), "utf8"))
  .replace('from "./selectors"', `from "${selectorsUrl}"`);
const { findChatInput, waitForChatReady, sendChatMessage, waitForSendConfirmation, detectStreamStatus } = await import(asModule(chatCode));
const { youtubeSelectors } = await import(selectorsUrl);

test("stream status ignores viewers' messages and inspects only player/info notices", async () => {
  const page = text => ({locator(selector){assert.notEqual(selector,'body');return {first:()=>({isVisible:async()=>selector==='ytd-watch-info-text',innerText:async()=>text})}}});
  assert.equal((await detectStreamStatus(page('Started streaming 2 hours ago'))).active,true);
  assert.equal((await detectStreamStatus(page('Streamed live on August 30'))).ended,true);
  assert.equal((await detectStreamStatus(page('Scheduled for tomorrow'))).active,false);
});

const absent = () => [];
function group(getItems = absent, scope) {
  const api = {
    count: async () => getItems().length,
    nth: (index) => node(() => getItems()[index]),
    first: () => node(() => getItems()[0]),
    last: () => node(() => getItems().at(-1)),
  };
  if (scope) {
    api.locator = scope.locator;
    api.getByRole = scope.getByRole;
    api.getByPlaceholder = scope.getByPlaceholder;
  }
  return api;
}
function node(getItem) {
  return {
    isVisible: async () => !!getItem()?.visible,
    isEditable: async () => !!getItem()?.editable,
    innerText: async () => getItem()?.text ?? "",
    textContent: async () => getItem()?.text ?? "",
    elementHandle: async () => ({ contentFrame: async () => getItem()?.frame ?? null }),
    click: async () => { throw new Error("Unexpected click during an offline readiness check"); },
  };
}
function frame({ inputs = absent, notices = absent, detached = () => false } = {}) {
  return {
    url: () => "https://www.youtube.com/live_chat?v=offline",
    isDetached: detached,
    locator: (selector) => group(() => [
      ...inputs().filter((item) => item.selector === selector),
      ...notices().filter((item) => item.selector === selector),
    ]),
    getByRole: (_, { name }) => group(() => inputs().filter((item) => item.role && name.test(item.name ?? ""))),
    getByPlaceholder: (name) => group(() => inputs().filter((item) => name.test(item.placeholder ?? ""))),
  };
}
function page({ frames = absent, inline, closed = () => false } = {}) {
  return {
    frames, isClosed: closed,
    locator: (selector) => inline && (youtubeSelectors.chatContainers.includes(selector) || selector === youtubeSelectors.chatContainers.join(","))
      ? group(() => [{ visible: true }], inline) : group(),
    getByRole: () => { throw new Error("Unscoped page input search could select the video search box"); },
  };
}
const input = (extra = {}) => ({ visible: true, editable: true, role: true, name: "Chat", ...extra });
const options = { timeoutMs: 250, pollMs: 10 };

test("waits for a delayed iframe and delayed editable input", async () => {
  const started = Date.now();
  const chat = frame({ inputs: () => Date.now() - started >= 70 ? [input()] : [] });
  const watch = page({ frames: () => Date.now() - started >= 30 ? [chat] : [] });
  const ready = await waitForChatReady(watch, options);
  assert.ok(ready.input);
  assert.equal(ready.failure, null);
  assert.ok(Date.now() - started >= 70);
});

test("skips hidden and disabled matches rather than checking only the first", async () => {
  const ready = await findChatInput(frame({ inputs: () => [input({ visible: false }), input({ editable: false }), input()] }));
  assert.ok(ready);
  assert.equal(await ready.isEditable(), true);
});

test("detects a Chat… placeholder without an accessible name", async () => {
  assert.ok(await findChatInput(frame({ inputs: () => [input({ role: false, placeholder: "Chat…" })] })));
});

test("detects plaintext-only contenteditable fallback", async () => {
  assert.ok(await findChatInput(frame({ inputs: () => [input({ role: false, selector: '[contenteditable="plaintext-only"][role="textbox"]' })] })));
});

test("detects the observed YouTube empty-value contenteditable composer without role or placeholder", async () => {
  // Remote Elements inspector: <yt-live-chat-text-input-field-renderer>
  // <div id="input" contenteditable class="style-scope yt-live-chat-text-input-field-renderer"
  // tabindex="0" aria-invalid aria-label="Chat…"></div>
  const selector = 'yt-live-chat-text-input-field-renderer #input[contenteditable=""]';
  assert.ok(youtubeSelectors.chatInputs.includes(selector));
  const chat = frame({ inputs: () => [input({ role: false, selector })] });
  assert.ok((await waitForChatReady(page({ frames: () => [chat] }), options)).input);
  assert.ok((await waitForChatReady(page({ inline: chat }), options)).input);
});

test("empty-value contenteditable fallback still rejects hidden or noneditable inputs", async () => {
  const selector = 'yt-live-chat-text-input-field-renderer #input[contenteditable=""]';
  assert.equal(await findChatInput(frame({ inputs: () => [
    input({ role: false, selector, visible: false }),
    input({ role: false, selector, editable: false }),
  ] })), null);
});

test("detects textarea placeholder CSS fallback", async () => {
  assert.ok(await findChatInput(frame({ inputs: () => [input({ role: false, selector: 'textarea[placeholder^="Chat" i]' })] })));
});

test("supports inline live chat while keeping input discovery scoped", async () => {
  const ready = await waitForChatReady(page({ inline: frame({ inputs: () => [input()] }) }), options);
  assert.ok(ready.input);
});

test("does not treat a missing iframe as immediately unavailable", async () => {
  const started = Date.now();
  const ready = await waitForChatReady(page(), { timeoutMs: 45, pollMs: 10 });
  assert.equal(ready.failure.status, "ERROR");
  assert.match(ready.failure.reason, /did not become available/);
  assert.ok(Date.now() - started >= 40);
});

test("a present but disabled input times out without attempting to type", async () => {
  const chat = frame({ inputs: () => [input({ editable: false })] });
  const ready = await waitForChatReady(page({ frames: () => [chat] }), { timeoutMs: 35, pollMs: 10 });
  assert.equal(ready.input, null);
  assert.match(ready.failure.reason, /no editable message box/);
});

test("reacquires chat after YouTube replaces its iframe", async () => {
  const started = Date.now();
  const first = frame({ detached: () => Date.now() - started > 25 });
  const second = frame({ inputs: () => [input()] });
  const ready = await waitForChatReady(page({ frames: () => Date.now() - started > 25 ? [first, second] : [first] }), options);
  assert.equal(ready.root, second);
  assert.ok(ready.input);
});

test("subscriber restriction returns a reason without posting", async () => {
  const chat = frame({ notices: () => [{ visible: true, selector: "yt-live-chat-restricted-participation-renderer", text: "Subscribers-only chat" }] });
  const ready = await waitForChatReady(page({ frames: () => [chat] }), options);
  assert.equal(ready.failure.status, "ERROR");
  assert.match(ready.failure.reason, /subscribers-only/);
  assert.doesNotMatch(ready.failure.reason, /not eligible/);
});

const modeNotice = (text) => ({ visible: true, selector: "yt-live-chat-restricted-participation-renderer", text });

for (const mode of ["Subscribers-only chat", "Members-only chat", "Only channel subscribers of 5 minutes or longer can send messages"]) {
  test(`an enabled composer is not blocked by the informational notice: ${mode}`, async () => {
    const chat = frame({ inputs: () => [input()], notices: () => [modeNotice(mode)] });
    const ready = await waitForChatReady(page({ frames: () => [chat] }), options);
    assert.ok(ready.input);
    assert.equal(ready.failure, null);
  });
}

test("a subscribers-only banner waits for the eligible composer's delayed initialization", async () => {
  const started = Date.now();
  const chat = frame({
    inputs: () => Date.now() - started >= 60 ? [input()] : [],
    notices: () => [modeNotice("Subscribers-only chat")],
  });
  assert.ok((await waitForChatReady(page({ frames: () => [chat] }), options)).input);
  assert.ok(Date.now() - started >= 60);
});

for (const mode of ["Subscribers-only chat", "Members-only chat"]) {
  test(`a disabled composer with ${mode} remains blocked`, async () => {
    const chat = frame({ inputs: () => [input({ editable: false })], notices: () => [modeNotice(mode)] });
    const ready = await waitForChatReady(page({ frames: () => [chat] }), { timeoutMs: 35, pollMs: 10 });
    assert.equal(ready.input, null);
    assert.equal(ready.failure.status, "ERROR");
    assert.match(ready.failure.reason, /has not enabled/);
  });
}

for (const [notice, status] of [
  ["Subscribers-only chat. You cannot send messages in this chat.", "ERROR"],
  ["Subscribers-only chat. You need to be subscribed for 5 minutes.", "ERROR"],
  ["Members-only chat. You must be a member to chat.", "ERROR"],
  ["Subscribers-only chat. Sign in to chat", "AUTH_REQUIRED"],
  ["Subscribers-only chat. Live chat is disabled", "ERROR"],
  ["Subscribers-only chat. Slow mode: wait 45 seconds remaining", "RATE_LIMITED"],
]) {
  test(`a stale editable input does not override a genuine restriction: ${notice}`, async () => {
    const chat = frame({ inputs: () => [input()], notices: () => [modeNotice(notice)] });
    const ready = await waitForChatReady(page({ frames: () => [chat] }), options);
    assert.equal(ready.input, null);
    assert.equal(ready.failure.status, status);
  });
}

test("a disappeared mode banner is not reused as a stale failure", async () => {
  const started = Date.now();
  const chat = frame({ notices: () => Date.now() - started < 20 ? [modeNotice("Subscribers-only chat")] : [] });
  const ready = await waitForChatReady(page({ frames: () => [chat] }), { timeoutMs: 60, pollMs: 10 });
  assert.match(ready.failure.reason, /no editable message box/);
});

test("Stop cancels the pending eligibility check without typing", async () => {
  const controller = new AbortController();
  const chat = frame({ notices: () => [modeNotice("Subscribers-only chat")] });
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(waitForChatReady(page({ frames: () => [chat] }), {
      timeoutMs: 5000, pollMs: 1000, signal: controller.signal,
    }), { name: "AbortError" });
  } finally { clearTimeout(timer); }
});

test("slow-mode countdown is respected even while the input is disabled", async () => {
  const chat = frame({ notices: () => [{ visible: true, selector: "yt-live-chat-message-input-renderer", text: "Slow mode: wait 45 seconds remaining" }] });
  const ready = await waitForChatReady(page({ frames: () => [chat] }), options);
  assert.equal(ready.failure.status, "RATE_LIMITED");
  assert.equal(ready.failure.retryAfterSeconds, 45);
});

test("other viewers' text does not become a platform restriction", async () => {
  const chat = frame({ inputs: () => [input()], notices: () => [{ visible: true, selector: "#chat-messages", text: "sign in members-only slow mode wait 90 seconds" }] });
  assert.ok((await waitForChatReady(page({ frames: () => [chat] }), options)).input);
});

test("Stop cancels a pending readiness wait", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(waitForChatReady(page(), { timeoutMs: 5000, pollMs: 1000, signal: controller.signal }), { name: "AbortError" });
  } finally { clearTimeout(timer); }
});

test("an already stopped send does not navigate or submit", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sendChatMessage({}, "https://www.youtube.com/watch?v=offline", "Never send", controller.signal), { name: "AbortError" });
});

test("a closed browser fails clearly", async () => {
  await assert.rejects(waitForChatReady(page({ closed: () => true }), options), /browser page was closed/);
});

const confirmationOptions = { timeoutMs: 80, pollMs: 5, settleMs: 0 };
const confirmationInput = (read, visible = true) => ({
  inputValue: async () => read(), textContent: async () => read(), isVisible: async () => visible,
});
test("a delayed cleared composer is accepted rather than stopped after 900ms", async () => {
  const started = Date.now();
  const result = await waitForSendConfirmation(frame(), confirmationInput(() => Date.now() - started < 1100 ? "message" : ""), {
    timeoutMs: 1500, pollMs: 25, settleMs: 0,
  });
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started >= 1100);
});
test("an unchanged message becomes an uncertain delayed retry, never another Enter", async () => {
  const result = await waitForSendConfirmation(frame(), confirmationInput(() => "message"), confirmationOptions);
  assert.equal(result.retryable, true);
  assert.match(result.reason, /uncertain/);
});
test("a detached/unreadable composer is not counted as a sent message", async () => {
  const result = await waitForSendConfirmation(frame(), confirmationInput(() => { throw new Error("detached"); }), confirmationOptions);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});
test("a hidden cleared composer is not sufficient confirmation", async () => {
  assert.equal((await waitForSendConfirmation(frame(), confirmationInput(() => "", false), confirmationOptions)).ok, false);
});
for (const [text, status, retryable] of [
  ["Network error. Message not sent. Try again", "ERROR", true],
  ["Your message was rejected as spam", "ERROR", undefined],
  ["Sign in to chat", "AUTH_REQUIRED", undefined],
  ["Verify you are human", "ERROR", undefined],
  ["Slow mode: wait 45 seconds", "RATE_LIMITED", undefined],
  ["Too many messages. Try again in 3 minutes", "RATE_LIMITED", undefined],
]) {
  test(`confirmation respects platform rejection even after the draft clears: ${text}`, async () => {
    const root = frame({ notices: () => [{ visible: true, selector: "tp-yt-paper-toast", text }] });
    const result = await waitForSendConfirmation(root, confirmationInput(() => ""), confirmationOptions);
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.retryable, retryable);
    if (text.includes("3 minutes")) assert.equal(result.retryAfterSeconds, 180);
  });
}
test("Stop interrupts send confirmation without resending", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(waitForSendConfirmation(frame(), confirmationInput(() => "message"), {
      signal: controller.signal, timeoutMs: 10000, settleMs: 0, pollMs: 1000,
    }), { name: "AbortError" });
  } finally { clearTimeout(timer); }
});
