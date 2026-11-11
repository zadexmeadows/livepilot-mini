import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type Row = Record<string, string | number | null>;
export type BankConfig = { economy: string; youtubeUrl: string; accountIds: string[]; bankAccountId: string | null; protectedReserve: number; minimumTransfer: number; maximumTransfer: number; delaySeconds: number; responseTimeoutSeconds: number; bankPresenceMessage: string; autoConsolidate: boolean };
const now = () => new Date().toISOString();
export const MAX_POINTS = 9_000_000_000_000;
export function points(value: number, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum || value > MAX_POINTS) throw new Error("Points must be whole numbers within the supported range."); return value; }
export class Ledger {
  readonly sql: DatabaseSync;
  constructor(filename: string) { this.sql = new DatabaseSync(filename); this.sql.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;"); }
  rows(query: string, ...args: (string | number | null)[]) { return this.sql.prepare(query).all(...args) as Row[]; }
  one(query: string, ...args: (string | number | null)[]) { return this.sql.prepare(query).get(...args) as Row | undefined; }
  run(query: string, ...args: (string | number | null)[]) { return this.sql.prepare(query).run(...args); }
  atomic<T>(work: () => T): T { this.sql.exec("BEGIN IMMEDIATE"); try { const result = work(); this.sql.exec("COMMIT"); return result; } catch (e) { this.sql.exec("ROLLBACK"); throw e; } }
  audit(action: string, reference: string, reason: string, metadata: unknown = {}, actor = "administrator") { this.run("INSERT INTO BankAudit(action,actor,reference,reason,metadata,createdAt) VALUES(?,?,?,?,?,?)", action, actor, reference, reason, JSON.stringify(metadata), now()); }
  account(id: string) { const row = this.one("SELECT * FROM BankAccount WHERE id=?", id); if (!row) throw new Error("Bank account not found."); return row; }
  ensure(profile: { id: string; displayName: string; channelName?: string | null }, economy: string) {
    const id = `${economy}:${profile.id}`;
    this.run("INSERT INTO BankAccount(id,profileId,economy,name,handle,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(economy,profileId) DO UPDATE SET name=excluded.name,handle=excluded.handle", id, profile.id, economy, profile.displayName, profile.channelName ?? "", now(), now());
    return this.account(id);
  }
  private post(id: string, amount: number, type: string, key: string, reference: string, reason: string, source: string, actor = "system", stream: string | null = null, reversalOf: number | null = null) {
    const previous = this.one("SELECT * FROM BankEntry WHERE eventKey=?", key);
    if (previous) { if (previous.accountId !== id || previous.amount !== amount || previous.type !== type) throw new Error("Idempotency key was reused with different values."); return previous; }
    const account = this.account(id), before = Number(account.balance), after = points(before + amount);
    if (!Number.isSafeInteger(amount)) throw new Error("Invalid ledger amount.");
    this.run("INSERT INTO BankEntry(eventKey,accountId,amount,beforeBalance,afterBalance,type,source,reference,stream,reason,actor,reversalOf,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", key, id, amount, before, after, type, source, reference, stream, reason, actor, reversalOf, now());
    this.run("UPDATE BankAccount SET balance=?,known=1,version=version+1,updatedAt=? WHERE id=?", after, now(), id);
    return this.one("SELECT * FROM BankEntry WHERE eventKey=?", key)!;
  }
  verify(id: string, amount: number, eventKey: string, source = "STREAMLABS", observedAt = now()) {
    points(amount);
    return this.atomic(() => {
      const previous = this.one("SELECT * FROM BankVerification WHERE eventKey=?", eventKey);
      if (previous) { if (previous.accountId !== id || previous.externalBalance !== amount) throw new Error("Verification key conflicts with previous evidence."); return previous; }
      const a = this.account(id), delta = amount - Number(a.balance);
      if (delta || !a.known) this.post(id, delta, a.known ? "VERIFICATION_CORRECTION" : "OPENING", eventKey, eventKey, `External balance ${a.balance} → ${amount}`, source);
      this.run("UPDATE BankAccount SET verifiedBalance=?,verifiedAt=?,known=1,updatedAt=?,version=version+1 WHERE id=?", amount, observedAt, now(), id);
      this.run("INSERT INTO BankVerification VALUES(?,?,?,?,?,?,?,?)", randomUUID(), id, eventKey, Number(a.balance), amount, delta, source, observedAt);
      this.audit("VERIFY", id, "Balance reconciled with external evidence", { before: a.balance, after: amount, difference: delta, eventKey }, source);
      return this.account(id);
    });
  }
  adjust(id: string, amount: number, reason: string, requestKey: string) {
    if (!reason.trim() || !Number.isSafeInteger(amount) || !amount) throw new Error("Provide a nonzero whole-point adjustment and a reason.");
    return this.atomic(() => { const a = this.account(id); this.assertAvailable(id); if (!a.known) throw new Error("Verify an opening balance first."); const entry = this.post(id, amount, "ADJUSTMENT", `adjust:${requestKey}`, requestKey, reason, "LOCAL", "administrator"); this.audit("ADJUST", id, reason, entry); return entry; });
  }
  reverse(entryId: number, reason: string, requestKey: string) {
    return this.atomic(() => { const e = this.one("SELECT * FROM BankEntry WHERE id=?", entryId); if (!e || e.type !== "ADJUSTMENT") throw new Error("Only local manual adjustments can be reversed here. External transfers require a new confirmed return transfer."); if (!reason.trim()) throw new Error("A reversal reason is required."); this.assertAvailable(String(e.accountId)); const entry = this.post(String(e.accountId), -Number(e.amount), "REVERSAL", `reverse:${requestKey}`, String(entryId), reason, "LOCAL", "administrator", null, entryId); this.audit("REVERSE", String(entryId), reason, entry); return entry; });
  }
  assertAvailable(id: string) {
    const a = this.account(id); if (a.frozen) throw new Error(`${a.name} is frozen.`);
    if (this.one("SELECT id FROM BankTransfer WHERE (sender=? OR receiver=?) AND status IN ('PREPARED','SUBMITTED','UNCERTAIN')", id, id)) throw new Error(`${a.name} has an unresolved transfer. Reconcile it first.`);
  }
  prepareTransfer(sender: string, receiver: string, amount: number, requestKey: string, kind = "TRANSFER", reserve = 0) {
    points(amount, 1); points(reserve);
    return this.atomic(() => {
      const old = this.one("SELECT * FROM BankTransfer WHERE requestKey=?", requestKey);
      if (old) { if (old.sender !== sender || old.receiver !== receiver || old.amount !== amount) throw new Error("Transfer key reused with different values."); return old; }
      if (sender === receiver) throw new Error("Choose different accounts.");
      this.assertAvailable(sender); this.assertAvailable(receiver);
      const a = this.account(sender), b = this.account(receiver);
      if (a.economy !== b.economy) throw new Error("Accounts belong to different points economies.");
      if (!a.known || !b.known) throw new Error("Verify both balances first.");
      if (Number(a.balance) - amount < reserve) throw new Error("Insufficient available balance after the protected reserve.");
      points(Number(b.balance) + amount);
      const id = randomUUID(), handle = String(b.handle).replace(/^@/, "");
      if (!handle || /\s/.test(handle)) throw new Error("Recipient has no valid channel handle.");
      this.run("INSERT INTO BankTransfer(id,requestKey,sender,receiver,amount,kind,status,command,createdAt,updatedAt) VALUES(?,?,?,?,?,?,'PREPARED',?,?,?)", id, requestKey, sender, receiver, amount, kind, `!give ${handle} ${amount}`, now(), now());
      this.audit("TRANSFER_PREPARED", id, "External command intent persisted", { sender, receiver, amount });
      return this.one("SELECT * FROM BankTransfer WHERE id=?", id)!;
    });
  }
  transferStatus(id: string, status: "SUBMITTED" | "UNCERTAIN" | "FAILED", reason: string) {
    this.atomic(() => { const t = this.one("SELECT * FROM BankTransfer WHERE id=?", id); if (!t || t.status === "CONFIRMED") throw new Error("Transfer cannot change status."); this.run("UPDATE BankTransfer SET status=?,reason=?,updatedAt=? WHERE id=?", status, reason, now(), id); this.audit(status, id, reason); });
  }
  confirmTransfer(id: string, messageId: string) {
    return this.atomic(() => {
      const t = this.one("SELECT * FROM BankTransfer WHERE id=?", id); if (!t) throw new Error("Transfer not found."); if (t.status === "CONFIRMED") return t;
      if (!['SUBMITTED', 'UNCERTAIN'].includes(String(t.status))) throw new Error("Transfer was not submitted.");
      this.post(String(t.sender), -Number(t.amount), `${t.kind}_SENT`, `transfer:${id}:sent`, id, "Streamlabs confirmed transfer", "STREAMLABS");
      this.post(String(t.receiver), Number(t.amount), `${t.kind}_RECEIVED`, `transfer:${id}:received`, id, "Streamlabs confirmed transfer", "STREAMLABS");
      this.run("UPDATE BankTransfer SET status='CONFIRMED',sourceMessageId=?,reason=NULL,updatedAt=? WHERE id=?", messageId, now(), id);
      this.audit("TRANSFER_CONFIRMED", id, "Atomic debit and credit posted", { messageId }, "STREAMLABS"); return this.one("SELECT * FROM BankTransfer WHERE id=?", id)!;
    });
  }
  resolveUncertain(id: string, reason: string) {
    return this.atomic(() => {
      const t = this.one("SELECT * FROM BankTransfer WHERE id=?", id); if (!t || t.status !== "UNCERTAIN" || !reason.trim()) throw new Error("Select an uncertain transfer and supply review evidence.");
      for (const accountId of [t.sender, t.receiver]) { const a = this.account(String(accountId)); if (!a.verifiedAt || String(a.verifiedAt) <= String(t.updatedAt)) throw new Error("Verify both external balances after the uncertain operation before resolving it."); }
      this.run("UPDATE BankTransfer SET status='RECONCILED',reason=?,updatedAt=? WHERE id=?", reason, now(), id); this.audit("TRANSFER_RECONCILED", id, reason, { note: "Balances reconciled; transfer outcome not inferred. No resend or extra debit/credit." });
    });
  }
  freeze(id: string, frozen: boolean, reason: string) { this.atomic(() => { if (!reason.trim()) throw new Error("A reason is required."); this.account(id); this.run("UPDATE BankAccount SET frozen=?,updatedAt=? WHERE id=?", frozen ? 1 : 0, now(), id); this.audit(frozen ? "FREEZE" : "UNFREEZE", id, reason); }); }
  config(): BankConfig {
    const raw = JSON.parse(String(this.one("SELECT value FROM BankMeta WHERE key='config'")?.value ?? '{}')) as Partial<BankConfig>;
    return { economy: raw.economy || "streamlabs-primary", youtubeUrl: raw.youtubeUrl || "", accountIds: Array.isArray(raw.accountIds) ? raw.accountIds : [], bankAccountId: raw.bankAccountId || null, protectedReserve: Number(raw.protectedReserve ?? 1337), minimumTransfer: Number(raw.minimumTransfer ?? 100), maximumTransfer: Number(raw.maximumTransfer ?? 5000), delaySeconds: Number(raw.delaySeconds ?? 10), responseTimeoutSeconds: Number(raw.responseTimeoutSeconds ?? 30), bankPresenceMessage: raw.bankPresenceMessage || ".", autoConsolidate: Boolean(raw.autoConsolidate) };
  }
  saveConfig(config: BankConfig) { this.atomic(() => { if (this.one("SELECT id FROM BankJob WHERE status='RUNNING'")) throw new Error("Stop the bank operation before changing settings."); this.run("INSERT INTO BankMeta VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(config)); this.audit("CONFIGURE", config.economy, "Bank configuration updated", config); }); }
  importLegacy(profiles: {id: string; displayName: string; channelName?: string | null}[], legacyConfig: BankConfig, evidence: { balances?: Record<string, {balance:number;verifiedAt:string}> } & Record<string, unknown>) {
    if (this.one("SELECT key FROM BankMeta WHERE key='legacy-import'")) return;
    this.atomic(() => {
      const imported: BankConfig = { economy: "streamlabs-primary", youtubeUrl: legacyConfig.youtubeUrl || "", accountIds: Array.isArray(legacyConfig.accountIds) ? legacyConfig.accountIds : [], bankAccountId: legacyConfig.bankAccountId ? `streamlabs-primary:${String(legacyConfig.bankAccountId).replace(/^streamlabs-primary:/, "")}` : null, protectedReserve: Number(legacyConfig.protectedReserve ?? 1337), minimumTransfer: Number(legacyConfig.minimumTransfer ?? 100), maximumTransfer: Number(legacyConfig.maximumTransfer ?? 5000), delaySeconds: Number(legacyConfig.delaySeconds ?? 10), responseTimeoutSeconds: Number(legacyConfig.responseTimeoutSeconds ?? 30), bankPresenceMessage: legacyConfig.bankPresenceMessage || ".", autoConsolidate: false };
      this.run("INSERT INTO BankMeta VALUES('config',?)", JSON.stringify(imported));
      this.run("INSERT INTO BankMeta VALUES('legacy-import',?)", JSON.stringify(evidence));
      for (const profile of profiles) { const a = this.ensure(profile, "streamlabs-primary"), b = evidence.balances?.[profile.id]; if (b && Number.isSafeInteger(b.balance) && b.balance >= 0) { this.post(String(a.id), b.balance, "OPENING", `legacy:${profile.id}`, "legacy-import", "Imported last-known balance; earlier history is archived, not replayed", "LEGACY"); this.run("UPDATE BankAccount SET verifiedBalance=?,verifiedAt=? WHERE id=?", b.balance, b.verifiedAt, String(a.id)); } }
      this.audit("MIGRATION", "legacy-import", "Opening balances imported; historical evidence retained without replay", { profiles: profiles.length });
    });
  }
  startJob(kind: string, requestKey: string, payload: unknown) {
    return this.atomic(() => { const old = this.one("SELECT * FROM BankJob WHERE requestKey=?", requestKey); if (old) { if (old.kind !== kind || old.payload !== JSON.stringify(payload)) throw new Error("Operation key conflicts with previous request."); return { job: old, created: false }; } if (this.one("SELECT id FROM BankJob WHERE status='RUNNING'")) throw new Error("A bank operation is already running."); const id = randomUUID(); this.run("INSERT INTO BankJob VALUES(?,?,?,'RUNNING',?,'Starting',?,?)", id, requestKey, kind, JSON.stringify(payload), now(), now()); return { job: this.one("SELECT * FROM BankJob WHERE id=?", id)!, created: true }; });
  }
  jobStatus(id: string, status: string, detail: string) { this.run("UPDATE BankJob SET status=?,detail=?,updatedAt=? WHERE id=?", status, detail, now(), id); }
  recover() { this.atomic(() => { this.run("UPDATE BankTransfer SET status='UNCERTAIN',reason='Process restarted after command intent; verify both balances before review',updatedAt=? WHERE status='SUBMITTED'", now()); this.run("UPDATE BankTransfer SET status='FAILED',reason='Restarted before submission',updatedAt=? WHERE status='PREPARED'", now()); this.run("UPDATE BankJob SET status='INTERRUPTED',detail='Server restarted; no automatic replay',updatedAt=? WHERE status='RUNNING'", now()); }); }
}

const scope = globalThis as unknown as { bankLedger?: Ledger };
export function getLedger() {
  if (!scope.bankLedger) {
    const url = process.env.DATABASE_URL ?? "file:../data/app.db";
    if (!url.startsWith("file:")) throw new Error("Bank ledger requires the project's SQLite database.");
    const filename = url.slice(5).split("?")[0];
    scope.bankLedger = new Ledger(path.isAbsolute(filename) ? filename : path.resolve(process.cwd(), "prisma", filename));
    scope.bankLedger.recover();
  }
  return scope.bankLedger;
}
