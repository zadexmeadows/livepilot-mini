// Runs the real controller with isolated in-memory DB/browser adapters and a
// manually advanced scheduler. No browser, Google account, network or messages.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const compile = (s) => ts.transpileModule(s, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = (s) => `data:text/javascript;base64,${Buffer.from(s).toString("base64")}`;
const source = async (p) => compile(await readFile(new URL(p, import.meta.url), "utf8"));
const policyUrl = url(await source("../lib/automation/retry-policy.ts"));
const limitsUrl = url(await source("../lib/automation/session-limits.ts"));
const controllerSource = await source("../lib/automation/automation-controller.ts");
const { retryDelaySeconds, isTransientBrowserError } = await import(policyUrl);
let serial = 0;
async function fixture(outcomes) {
  const mockUrl = url(`// fixture ${serial++}
export const state = {
 row:{id:'test',name:'Test',googleAccountId:'account-A',googleAccount:{displayName:'Test',status:'CONNECTED'},status:'DRAFT',intervalSeconds:30,runUntilStopped:true,maxMessages:100,sessionMessagesSent:0,messagesSent:0,stopMode:'NONE',stopValue:null,stopAt:null,scheduleMode:'IMMEDIATE',youtubeUrl:'https://www.youtube.com/watch?v=offline',message:'never sent'},
 logs:[], outcomes:[], calls:0, pages:[], delays:[], pending:[], execution:{}, failPage:null
};
function apply(row,data){for(const [key,value] of Object.entries(data))row[key]=value&&typeof value==='object'&&'increment' in value?(row[key]??0)+value.increment:value;return row;}
export const db={
 automation:{findMany:async()=>[state.row],findUnique:async()=>state.row,findUniqueOrThrow:async()=>state.row,update:async({data})=>apply(state.row,data),updateMany:async({data})=>apply(state.row,data)},
 automationExecution:{create:async()=>({id:'execution'}),update:async({data})=>apply(state.execution,data)},
 googleAccount:{update:async({data})=>apply(state.row.googleAccount,data)}
};
export const browserManager={newPage:async(accountId)=>{
 if(state.failPage){const error=state.failPage;state.failPage=null;throw error;}
 const page={accountId,closed:false,isClosed(){return this.closed},async close(){this.closed=true}};state.pages.push(page);return page;
},closePage:async(accountId,page)=>{if(accountId!==page.accountId)throw Error('Wrong account page closed');await page.close()}};
export const activityLog=async(row)=>{state.logs.push(row)};
export const emitDashboardEvent=()=>{};
export const sendChatMessage=async()=>{state.calls++;const item=state.outcomes.shift();if(item instanceof Error)throw item;if(!item)throw Error('Unexpected send');return item};
export const accountAccess={run:async(id,signal,work)=>{signal.throwIfAborted();return work()}};
export const delay=(ms,signal)=>{state.delays.push(ms);return new Promise((resolve,reject)=>{
 if(signal.aborted){reject(new DOMException('Aborted','AbortError'));return;}
 const finish=()=>{signal.removeEventListener('abort',abort);resolve()};
 const abort=()=>{state.pending=state.pending.filter(f=>f!==finish);reject(new DOMException('Aborted','AbortError'))};
 state.pending.push(finish);signal.addEventListener('abort',abort,{once:true});
})};`);
  const mock = await import(mockUrl);
  mock.state.outcomes = [...outcomes];
  let code = controllerSource.replace('from "./session-limits"', `from "${limitsUrl}"`).replace('from "./retry-policy"', `from "${policyUrl}"`);
  code = code.replace('import { StreamlabsController } from "./streamlabs-controller";', 'class StreamlabsController { enabled=false; snapshot(){return {enabled:this.enabled}} isRunning(){return this.enabled} runningCount(){return this.enabled?1:0} async load(){return this.snapshot()} async configure(){return this.snapshot()} async start(){this.enabled=true;return this.snapshot()} async pause(){this.enabled=false;return this.snapshot()} async stop(){this.enabled=false;return this.snapshot()} }');
  code = code.replace('from "./account-access"', `from "${mockUrl}"`);
  for (const p of ["@/lib/db/client", "@/lib/browser/browser-manager", "@/lib/browser/youtube-chat", "@/lib/logger/activity-logger", "@/lib/events"]) {
    code = code.replace(`from "${p}"`, `from "${mockUrl}"`);
  }
  const { AutomationController } = await import(url(code));
  return { ...mock, controller: new AutomationController(mock.delay), advance: () => mock.state.pending.shift()?.() };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.ok(predicate(), "Controller did not reach expected state");
}
const temporary = { ok: false, status: "ERROR", retryable: true, reason: "Delivery unconfirmed" };
const sent = { ok: true, status: "SENT" };

test("Streamlabs controls do not interrupt a regular automation", async () => {
  const f=await fixture([sent]);await f.controller.start('test');await until(()=>f.state.pending.length===1);
  await f.controller.streamlabsStart();
  assert.equal(f.state.pending.length,1);assert.equal(f.controller.streamlabsState().enabled,true);assert.equal(f.state.calls,1);
  await f.controller.streamlabsPause();
  assert.equal(f.state.pending.length,1);assert.equal(f.controller.isRunning('test'),true);
  await f.controller.stopAll();
});

test("retry backoff never shortens the interval and grows to a 15-minute floor", () => {
  assert.deepEqual([1,2,3,4,5].map(n=>retryDelaySeconds(n,30)),[60,120,240,480,900]);
  assert.equal(retryDelaySeconds(1,300),300);
  assert.equal(retryDelaySeconds(5,3600),3600);
});
test("only temporary browser failures are retryable", () => {
  for (const message of ["net::ERR_CONNECTION_RESET", "Target page, context or browser has been closed", "frame was detached"]) assert.ok(isTransientBrowserError(new Error(message)));
  for (const message of ["CAPTCHA required", "net::ERR_CERT_INVALID", "sandbox failure", "profile lock", "database failure", "Sign in required"]) assert.equal(isTransientBrowserError(new Error(message)),false);
});
test("an uncertain send retries later, preserves account isolation, and recovers", async () => {
  const f=await fixture([temporary,sent]); await f.controller.start('test');
  await until(()=>f.state.row.status==='RETRYING'&&f.state.pending.length===1);
  assert.equal(f.state.calls,1); assert.equal(f.state.row.messagesSent,0);
  assert.ok(f.state.row.nextSendAt>Date.now()); assert.equal(f.state.delays[0],60000);
  assert.equal(f.state.pages[0].closed,true); assert.equal(f.state.logs.at(-1).level,'WARNING');
  assert.equal((await f.controller.start('test')).started,false);
  f.advance(); await until(()=>f.state.row.messagesSent===1&&f.state.pending.length===1);
  assert.equal(f.state.row.status,'RUNNING'); assert.equal(f.state.row.lastError,null);
  assert.ok(f.state.pages.every(p=>p.accountId==='account-A'));
  await f.controller.stop('test'); assert.equal(f.state.row.status,'STOPPED');
});
test("six consecutive failures stop after five delayed retries, without a tight loop", async () => {
  const f=await fixture(Array(6).fill(temporary)); await f.controller.start('test');
  for(let i=0;i<5;i++){await until(()=>f.state.pending.length===1);assert.equal(f.state.calls,i+1);f.advance();}
  await until(()=>!f.controller.isRunning('test'));
  assert.equal(f.state.calls,6); assert.equal(f.state.row.status,'ERROR');
  assert.equal(f.state.row.nextSendAt,null); assert.match(f.state.row.lastError,/6 consecutive/);
  assert.equal(f.state.execution.errorCount,6); assert.equal(f.state.row.messagesSent,0);
});
test("success resets the consecutive retry budget", async () => {
  const f=await fixture([temporary,sent,temporary,sent]);await f.controller.start('test');
  for(let i=0;i<3;i++){await until(()=>f.state.pending.length===1);f.advance();}
  await until(()=>f.state.row.messagesSent===2&&f.state.pending.length===1);
  assert.deepEqual(f.state.delays,[60000,30000,60000,30000]); await f.controller.stop('test');
});
for(const action of ['pause','stop','stopAll']) {
  test(`${action} cancels a retry and never sends again`,async()=>{
    const f=await fixture([temporary,sent]);await f.controller.start('test');await until(()=>f.state.pending.length===1);
    await f.controller[action]('test');assert.equal(f.state.calls,1);assert.equal(f.controller.isRunning('test'),false);
    assert.equal(f.state.pending.length,0);assert.equal(f.state.row.status,action==='pause'?'PAUSED':'STOPPED');
  });
}
for(const status of ['AUTH_REQUIRED','ERROR']) {
  test(`genuine ${status} does not automatically retry`,async()=>{
    const f=await fixture([{ok:false,status,reason:'Actual platform restriction'}]);await f.controller.start('test');
    await until(()=>!f.controller.isRunning('test'));assert.equal(f.state.calls,1);assert.equal(f.state.delays.length,0);assert.equal(f.state.row.status,status);
  });
}
test("YouTube retry duration is respected without consuming transient retry budget",async()=>{
  const f=await fixture([{ok:false,status:'RATE_LIMITED',retryAfterSeconds:180},temporary,sent]);await f.controller.start('test');
  await until(()=>f.state.pending.length===1);assert.equal(f.state.row.status,'RATE_LIMITED');assert.equal(f.state.delays[0],180000);f.advance();
  await until(()=>f.state.pending.length===1);assert.equal(f.state.delays[1],60000);await f.controller.stop('test');
});
test("browser creation can recover without changing profiles",async()=>{
  const f=await fixture([sent]);f.state.failPage=Object.assign(new Error('Timeout 45000ms exceeded'),{name:'TimeoutError'});await f.controller.start('test');
  await until(()=>f.state.pending.length===1);assert.equal(f.state.calls,0);f.advance();
  await until(()=>f.state.row.messagesSent===1&&f.state.pending.length===1);await f.controller.stop('test');
});
test("a scheduled duration limit still completes while recovering",async()=>{
  const f=await fixture([temporary,sent]);await f.controller.start('test');await until(()=>f.state.pending.length===1);
  Object.assign(f.state.row,{runUntilStopped:false,stopMode:'DATETIME',stopAt:new Date(0)});f.advance();
  await until(()=>!f.controller.isRunning('test'));assert.equal(f.state.row.status,'COMPLETED');assert.equal(f.state.calls,1);
});
