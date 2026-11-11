import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const source = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const matcherUrl = url(await source("../lib/automation/streamlabs-matcher.ts"));
const intelligenceUrl = url(await source("../lib/automation/streamlabs-intelligence.ts"));
const policyUrl = url(await source("../lib/automation/retry-policy.ts"));
const cancelUrl = url(await source("../lib/automation/cancellation.ts"));
const controllerSource = await source("../lib/automation/streamlabs-controller.ts");
const { isHeistAnnouncement, AnnouncementTracker } = await import(matcherUrl);
const { parsePointsBalance, parseTransfer, parseHeistJoin, parseHeistResults, parseRoll, sameStreamlabsName } = await import(intelligenceUrl);
const announcement = (id = "event1", author = "Streamlabs", text = "Ahoy! Captain Alice is trying to get a crew together for a treasure hunt! Type !heist [amount] to join.") => ({ id, author, text });

test("matches Streamlabs treasure-hunt announcements only", () => {
  assert.ok(isHeistAnnouncement(announcement()));
  assert.ok(isHeistAnnouncement(announcement("2", "@Streamlabs", "AHOY! Captain Bob wants a crew for a treasure hunt. Type !heist 100 to join!")));
  assert.equal(isHeistAnnouncement(announcement("3", "Viewer")), false);
  assert.equal(isHeistAnnouncement(announcement("", "Streamlabs")), false);
});

test("announcement tracker baselines history and accepts a new stable id once", () => {
  const tracker = new AnnouncementTracker();
  assert.deepEqual(tracker.observe([announcement("old")]), []);
  assert.deepEqual(tracker.observe([announcement("old"), announcement("new")]).map(item => item.id), ["new"]);
  assert.deepEqual(tracker.observe([announcement("new")]), []);
});

test("parses observed Streamlabs balance, transfer, heist, and roll messages", () => {
  assert.deepEqual(parsePointsBalance("@SARA_KHAN4, you have 30500 Points."), { username: "SARA_KHAN4", balance: 30500 });
  assert.deepEqual(parseTransfer("RooV gave 50000 Points to 4xhuu."), { donor: "RooV", amount: 50000, recipient: "4xhuu", ok: true });
  assert.deepEqual(parseTransfer("SARA_PATHAN12 failed to give 10000 Points to SARA_KHAN4. FeelsBadMan"), { donor: "SARA_PATHAN12", amount: 10000, recipient: "SARA_KHAN4", ok: false });
  assert.deepEqual(parseHeistJoin("Ahoy! @JackTheClipper has joined the treasure hunt."), { username: "JackTheClipper" });
  assert.deepEqual(parseHeistResults("Results: JackTheClipper (2674), Kevin (2,674)"), { winners: [{ username: "JackTheClipper", payout: 2674 }, { username: "Kevin", payout: 2674 }] });
  assert.deepEqual(parseRoll("Rolled 66, @RooV won 20000 Points and now has 171300 Points"), { username: "RooV", won: true, amount: 20000, balance: 171300 });
  assert.ok(sameStreamlabsName("＠ＳＡＲＡ_KHAN4", "sara_khan4"));
});

let serial = 0;
async function fixture(t, count = 3, overrides = {}) {
  const mockUrl = url(`// fixture ${serial++}
export const state={now:2000000000000,accounts:[],logs:[],sends:[],messages:[],pending:[],pages:[],claims:new Set(),settings:{},access:[]};
export const db={
 appSetting:{findUnique:async({where})=>state.settings[where.key]?{value:state.settings[where.key]}:null,upsert:async({where,create,update})=>{state.settings[where.key]=(state.settings[where.key]?update:create).value},create:async({data})=>{state.settings[data.key]=data.value}},
 automation:{findMany:async()=>[]},
 googleAccount:{count:async({where})=>state.accounts.filter(a=>where.id.in.includes(a.id)&&a.status===where.status).length,findMany:async({where})=>state.accounts.filter(a=>where.id.in.includes(a.id)&&(!where.status||a.status===where.status)),findUniqueOrThrow:async({where})=>state.accounts.find(a=>a.id===where.id)},
 streamlabsTrigger:{create:async({data})=>{const key=data.videoId+'/'+data.messageId;if(state.claims.has(key))throw {code:'P2002'};state.claims.add(key)}}
};
export const browserManager={newPage:async accountId=>{const page={accountId,closed:false,isClosed(){return this.closed},async goto(){},async close(){this.closed=true}};state.pages.push(page);return page},closePage:async(id,page)=>{if(id!==page.accountId)throw Error('isolation');await page.close()}};
export const sendChatMessage=async(page,target,message,signal)=>{signal.throwIfAborted();state.sends.push({accountId:page.accountId,target,message,at:state.now});return {ok:true,status:'SENT'}};
export const detectAccountStatus=async()=>({authenticated:true}); export const detectStreamStatus=async()=>({active:true,ended:false});
export const parseYouTubeUrl=value=>({videoId:'video1',canonicalUrl:value}); export const readStreamlabsChat=async()=>state.messages;
export const activityLog=async row=>state.logs.push(row); export const emitDashboardEvent=()=>{};
export const captureBankRound=async()=>{};
export const accountAccess={run:async(id,signal,work)=>{state.access.push(id);signal.throwIfAborted();return work()}};
export const delay=(ms,signal)=>new Promise((resolve,reject)=>{signal.throwIfAborted();const entry={at:state.now+ms,resolve:()=>{signal.removeEventListener('abort',abort);resolve()}};const abort=()=>{state.pending=state.pending.filter(x=>x!==entry);reject(signal.reason)};state.pending.push(entry);signal.addEventListener('abort',abort,{once:true})});
`);
  const mock = await import(mockUrl);
  mock.state.accounts = Array.from({ length: count }, (_, index) => ({ id: `account${index}`, displayName: `Account ${index}`, channelName: `@account${index}`, status: "CONNECTED", profileDirectory: `/tmp/account${index}` }));
  let code = controllerSource.replace('from "./streamlabs-matcher"', `from "${matcherUrl}"`).replace('from "./streamlabs-intelligence"', `from "${intelligenceUrl}"`).replace('from "./cancellation"', `from "${cancelUrl}"`).replace('from "./retry-policy"', `from "${policyUrl}"`).replace('from "./account-access"', `from "${mockUrl}"`);
  for (const dep of ["@/lib/db/client", "@/lib/browser/browser-manager", "@/lib/browser/youtube-chat", "@/lib/browser/streamlabs-chat", "@/lib/logger/activity-logger", "@/lib/events", "../bank/streamlabs-adapter"]) code = code.replace(`from "${dep}"`, `from "${mockUrl}"`);
  const { StreamlabsController } = await import(url(code));
  const controller = new StreamlabsController(mock.delay);
  const originalNow = Date.now; Date.now = () => mock.state.now;
  const config = { youtubeUrl: "https://www.youtube.com/watch?v=video1", accountIds: mock.state.accounts.map(a => a.id), messages: ["one", "two", "three"], delaySeconds: 10, fallbackSeconds: 30, noMessageRepeats: false, ...overrides };
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate); };
  const tick = async ms => { mock.state.now += ms; const due = mock.state.pending.filter(item => item.at <= mock.state.now); mock.state.pending = mock.state.pending.filter(item => item.at > mock.state.now); due.forEach(item => item.resolve()); await flush(); };
  const poll = async ms => { for (let elapsed = 0; elapsed < ms; elapsed += 750) await tick(Math.min(750, ms - elapsed)); };
  const enable = async () => { mock.state.messages = [announcement("old")]; await controller.start(config); await flush(); await tick(2000); await flush(); };
  t.after(async () => { await controller.stop(); Date.now = originalNow; });
  return { ...mock, controller, config, tick, poll, enable };
}

test("announcement round shuffles accounts, uses each once, and spaces sends", async t => {
  const f = await fixture(t); await f.enable(); f.state.messages.push(announcement("new")); await f.poll(750);
  assert.equal(f.state.sends.length, 1); await f.tick(9999); assert.equal(f.state.sends.length, 1); await f.tick(1); await f.tick(10000);
  assert.equal(f.state.sends.length, 3); assert.equal(new Set(f.state.sends.map(send => send.accountId)).size, 3);
  assert.ok(f.state.sends.every(send => f.config.messages.includes(send.message))); assert.equal(f.controller.snapshot().lastRoundTrigger, "ANNOUNCEMENT");
});

test("timer starts a fallback round when no announcement appears", async t => {
  const f = await fixture(t, 1); await f.enable(); await f.poll(30000);
  assert.equal(f.state.sends.length, 1); assert.equal(f.controller.snapshot().lastRoundTrigger, "TIMER");
});

test("a claimed announcement cannot trigger twice but a new id can", async t => {
  const f = await fixture(t, 1, { fallbackSeconds: 300 }); await f.enable();
  f.state.messages.push(announcement("first")); await f.poll(750); assert.equal(f.state.sends.length, 1);
  await f.poll(750); assert.equal(f.state.sends.length, 1);
  f.state.messages.push(announcement("second")); await f.poll(750); assert.equal(f.state.sends.length, 2);
});

test("pause affects only Streamlabs state and leaves regular automation data untouched", async t => {
  const f = await fixture(t, 1); await f.enable(); const before = JSON.stringify(f.state.accounts); await f.controller.pause();
  assert.equal(f.controller.snapshot().phase, "PAUSED"); assert.equal(JSON.stringify(f.state.accounts), before); assert.equal(f.state.pending.length, 0);
});

test("no-repeat option uses distinct messages when the pool is large enough", async t => {
  const f = await fixture(t, 3, { noMessageRepeats: true }); await f.enable(); f.state.messages.push(announcement("new")); await f.poll(750); await f.tick(10000); await f.tick(10000);
  assert.equal(new Set(f.state.sends.map(send => send.message)).size, 3);
});

test("points inquiry can start independently while Streamlabs rounds are off", async t => {
  const f = await fixture(t, 2);
  await f.controller.configure(f.config);
  const state = await f.controller.checkPoints();
  assert.equal(state.enabled, false);
  assert.equal(state.intelligence.phase, "CHECKING_POINTS");
  await f.controller.cancelIntelligence();
  assert.equal(f.controller.snapshot().intelligence.phase, "IDLE");
});

test("loading removes deleted account ids from saved configuration", async t => {
  const f = await fixture(t, 2);
  f.state.settings.streamlabsConfig = JSON.stringify({ ...f.config, accountIds: ["account0", "deleted-account", "account1"], bankAccountId: "deleted-account" });
  const state = await f.controller.load();
  assert.deepEqual(state.config.accountIds, ["account0", "account1"]);
  assert.equal(state.config.bankAccountId, null);
  assert.deepEqual(JSON.parse(f.state.settings.streamlabsConfig).accountIds, ["account0", "account1"]);
});

test("livestream URL can be saved independently from the full settings form", async t => {
  const f = await fixture(t, 2);
  await f.controller.configure(f.config);
  const state = await f.controller.updateYouTubeUrl("https://www.youtube.com/watch?v=newVideo123");
  assert.equal(state.config.youtubeUrl, "https://www.youtube.com/watch?v=newVideo123");
  assert.equal(JSON.parse(f.state.settings.streamlabsConfig).youtubeUrl, "https://www.youtube.com/watch?v=newVideo123");
  assert.equal(f.state.logs.at(-1).action, "STREAMLABS_URL_UPDATED");
});

test("points transfers put the recipient username before the amount", () => {
  assert.match(controllerSource, /`!give \$\{recipientUsername\} \$\{amount\}`/);
  assert.match(controllerSource, /`!give \$\{bankUsername\} \$\{amount\}`/);
  assert.doesNotMatch(controllerSource, /`!give \$\{amount\} \$\{(?:recipientUsername|bankUsername)\}`/);
});
