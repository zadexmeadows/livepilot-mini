import type { GoogleAccount } from "@prisma/client";
import type { Page } from "playwright";
import { db } from "../db/client";
import { browserManager } from "../browser/browser-manager";
import { detectAccountStatus, parseYouTubeUrl, sendChatMessage } from "../browser/youtube-chat";
import { readStreamlabsChat } from "../browser/streamlabs-chat";
import { accountAccess } from "../automation/account-access";
import { cancellableDelay } from "../automation/cancellation";
import { isStreamlabsMessage, parsePointsBalance, parseTransfer, sameStreamlabsName } from "../automation/streamlabs-intelligence";
import { getLedger, type BankConfig } from "./ledger";
import { emitDashboardEvent } from "../events";
import type { ChatAnnouncement } from "../automation/streamlabs-matcher";

export async function initializeBank() {
  const l = getLedger();
  const profiles = await db.googleAccount.findMany();
  if (!l.one("SELECT key FROM BankMeta WHERE key='legacy-import'")) {
    const records = await db.appSetting.findMany({ where: { key: { in: ["streamlabsConfig", "streamlabsIntelligence"] } } });
    const old = (key: string) => JSON.parse(records.find(r => r.key === key)?.value ?? "{}");
    l.importLegacy(profiles, { protectedReserve: 1337, minimumTransfer: 100, maximumTransfer: 5000, delaySeconds: 10, responseTimeoutSeconds: 30, bankPresenceMessage: ".", accountIds: [], bankAccountId: null, youtubeUrl: "", ...old("streamlabsConfig") }, old("streamlabsIntelligence"));
  }
  const config = l.config();
  for (const profile of profiles) l.ensure(profile, config.economy);
  return { l, profiles, config };
}

export class BankWorker {
  private abort?: AbortController;
  private task?: Promise<void>;
  async start(kind: "VERIFY" | "TRANSFER" | "ACCUMULATE", requestKey: string, input: { accountId?: string; sender?: string; receiver?: string; amount?: number } = {}) {
    const { l, profiles, config } = await initializeBank();
    parseYouTubeUrl(config.youtubeUrl);
    const selected = profiles.filter(a => config.accountIds.includes(a.id));
    if (!selected.length) throw new Error("Select accounts in Bank settings.");
    const result = l.startJob(kind, requestKey, input);
    if (!result.created) return result.job;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const id = String(result.job.id);
    this.task = this.execute(kind, id, requestKey, input, selected, config, signal).then(() => { l.jobStatus(id, "COMPLETED", "Operation completed with confirmed external responses."); }).catch(error => { l.jobStatus(id, signal.aborted ? "CANCELLED" : "FAILED", error instanceof Error ? error.message : String(error)); l.audit("OPERATION_FAILED", id, error instanceof Error ? error.message : String(error)); }).finally(() => { this.task = undefined; this.abort = undefined; emitDashboardEvent("bank.updated", { id }); });
    return result.job;
  }
  async stop() { this.abort?.abort(); await this.task; }
  private async execute(kind: string, jobId: string, requestKey: string, input: { accountId?: string; sender?: string; receiver?: string; amount?: number }, accounts: GoogleAccount[], config: BankConfig, signal: AbortSignal) {
    const l = getLedger(), pages = new Map<string, Page>(), releases: (()=>void)[] = [];
    const bankId = (a: GoogleAccount) => `${config.economy}:${a.id}`;
    const choose = (id?: string) => { const a = accounts.find(a => bankId(a) === id || a.id === id); if (!a) throw new Error("Select an account from Bank settings."); return a; };
    const required = kind === "VERIFY" && input.accountId ? [choose(input.accountId)] : kind === "TRANSFER" ? [choose(input.sender), choose(input.receiver)] : accounts;
    for (const a of required) { if (a.status !== "CONNECTED" || !a.channelName?.startsWith("@")) throw new Error(`Reconnect ${a.displayName} and confirm its channel handle.`); if (l.account(bankId(a)).frozen) throw new Error(`${a.displayName} is frozen.`); }
    const update = (text: string) => { l.jobStatus(jobId, "RUNNING", text); emitDashboardEvent("bank.updated", { jobId }); };
    const rows = async (page: Page) => { const result = await readStreamlabsChat(page); if (!result) throw new Error("Live chat is unavailable."); return result; };
    const wait = async <T,>(page: Page, baseline: Set<string>, match: (m: ChatAnnouncement) => T | null) => {
      const end = Date.now() + config.responseTimeoutSeconds * 1000;
      while (Date.now() < end) { signal.throwIfAborted(); for (const m of await rows(page)) if (m.id && !baseline.has(m.id)) { const value = match(m); if (value !== null) return { message: m, value }; } await cancellableDelay(750, signal); }
      throw new Error("No matching Streamlabs confirmation before timeout.");
    };
    const pageFor = async (a: GoogleAccount) => {
      let page = pages.get(a.id); if (page) return page;
      page = await browserManager.newPage(a.id); pages.set(a.id, page);
      await page.goto(config.youtubeUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      const end = Date.now()+30000;
      while (true) { signal.throwIfAborted(); const status = await detectAccountStatus(page); if (status.authenticated) break; if (status.signedOut || Date.now() >= end) throw new Error(`${a.displayName}: ${status.reason}`); await cancellableDelay(750,signal); }
      while (!await readStreamlabsChat(page)) { signal.throwIfAborted(); if (Date.now() >= end) throw new Error(`${a.displayName}: chat did not finish loading.`); await cancellableDelay(750,signal); }
      return page;
    };
    const send = async (a: GoogleAccount, command: string) => { const result = await sendChatMessage(await pageFor(a), config.youtubeUrl, command, signal, {prepared:true}); if (!result.ok) throw new Error(`${a.displayName}: ${result.reason ?? "Command not confirmed"}`); };
    const verify = async (a: GoogleAccount) => {
      update(`Verifying ${a.displayName}`);
      const page = await pageFor(a), baseline = new Set((await rows(page)).map(m=>m.id));
      await send(a, "!points");
      const found = await wait(page, baseline, m => { const parsed = isStreamlabsMessage(m) ? parsePointsBalance(m.text) : null; return parsed && sameStreamlabsName(parsed.username,a.channelName!) ? parsed : null; });
      l.verify(bankId(a), found.value.balance, `points:${config.economy}:${found.message.id}`);
      emitDashboardEvent("bank.updated", { accountId: bankId(a) });
      await cancellableDelay(config.delaySeconds*1000,signal);
      return found.value.balance;
    };
    const transfer = async (a: GoogleAccount, b: GoogleAccount, amount: number, key: string, transferKind: string) => {
      l.assertAvailable(bankId(a)); l.assertAvailable(bankId(b));
      await verify(a); await verify(b);
      const bankPage = await pageFor(b), presenceBaseline = new Set((await rows(bankPage)).map(m=>m.id));
      update(`Confirming ${b.displayName}'s presence`);
      await send(b,config.bankPresenceMessage);
      await wait(bankPage,presenceBaseline,m=>sameStreamlabsName(m.author,b.channelName!) && m.text.trim()===config.bankPresenceMessage ? true : null);
      await cancellableDelay(config.delaySeconds*1000,signal);
      const donorPage=await pageFor(a), baseline=new Set((await rows(donorPage)).map(m=>m.id));
      const t=l.prepareTransfer(bankId(a),bankId(b),amount,key,transferKind,config.protectedReserve);
      if(t.status!=="PREPARED") throw new Error(`Previous transfer is ${t.status}; it will not be resent.`);
      update(`Sending ${amount} points from ${a.displayName} to ${b.displayName}`);
      l.transferStatus(String(t.id),"SUBMITTED","Command may be delivered; no automatic replay");
      try {
        await send(a,String(t.command));
        const found=await wait(donorPage,baseline,m=>{ const parsed=isStreamlabsMessage(m)?parseTransfer(m.text):null; return parsed && parsed.amount===amount && sameStreamlabsName(parsed.donor,a.channelName!) && sameStreamlabsName(parsed.recipient,b.channelName!) ? parsed : null; });
        if(!found.value.ok) { l.transferStatus(String(t.id),"FAILED","Streamlabs explicitly rejected the command."); throw new Error("Streamlabs rejected this transfer."); }
        l.confirmTransfer(String(t.id),`${config.economy}:${found.message.id}`);
      } catch(error) { const latest=l.one("SELECT status FROM BankTransfer WHERE id=?",String(t.id)); if(latest?.status==="SUBMITTED") l.transferStatus(String(t.id),"UNCERTAIN",error instanceof Error?error.message:String(error)); throw error; }
      await cancellableDelay(config.delaySeconds*1000,signal);
      await verify(a); await verify(b);
    };
    try {
      // Hold sorted locks for the complete operation, including response matching.
      // Regular automations and heist sends queue behind these same account locks.
      for(const a of [...new Map(required.map(a=>[a.id,a])).values()].sort((a,b)=>a.id.localeCompare(b.id))) releases.push(await accountAccess.acquire(a.id,signal));
      if(kind==="VERIFY") { for(const a of required) await verify(a); }
      else if(kind==="TRANSFER") { const amount=input.amount!; if(amount>config.maximumTransfer) throw new Error("Amount exceeds the configured transfer maximum."); await transfer(choose(input.sender),choose(input.receiver),amount,requestKey,"TRANSFER"); }
      else {
        const bank=choose(config.bankAccountId??undefined); let index=0;
        for(const donor of accounts.filter(a=>a.id!==bank.id)) {
          l.assertAvailable(bankId(donor)); l.assertAvailable(bankId(bank));
          let balance=await verify(donor);
          while(balance-config.protectedReserve>=config.minimumTransfer) {
            const amount=Math.min(config.maximumTransfer,balance-config.protectedReserve);
            await transfer(donor,bank,amount,`${requestKey}:${index++}`,"ACCUMULATION");
            const next=Number(l.account(bankId(donor)).balance);
            if(next>=balance) throw new Error("Balance did not decrease after accumulation; review external results before continuing.");
            balance=next;
          }
        }
      }
    } finally { for(const [id,page] of pages) await browserManager.closePage(id,page); releases.reverse().forEach(release=>release()); }
  }
}
const shared=globalThis as unknown as { bankWorker?: BankWorker };
export const bankWorker=shared.bankWorker??=new BankWorker();
