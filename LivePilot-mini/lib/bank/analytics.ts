import { Ledger } from "./ledger";

export function analytics(l: Ledger, economy: string) {
  const accounts = l.rows(`SELECT a.*,
    COALESCE(SUM(CASE WHEN e.type='ROUND_WIN' THEN e.amount ELSE 0 END),0) won,
    COALESCE(SUM(CASE WHEN e.type='ROUND_LOSS' THEN -e.amount ELSE 0 END),0) lost,
    SUM(CASE WHEN e.type='ROUND_WIN' THEN 1 ELSE 0 END) wins,
    SUM(CASE WHEN e.type='ROUND_LOSS' THEN 1 ELSE 0 END) losses,
    COALESCE(SUM(CASE WHEN e.type LIKE '%_RECEIVED' THEN e.amount ELSE 0 END),0) received,
    COALESCE(SUM(CASE WHEN e.type LIKE '%_SENT' THEN -e.amount ELSE 0 END),0) sent,
    COALESCE(SUM(CASE WHEN e.type='ACCUMULATION_SENT' THEN -e.amount ELSE 0 END),0) contributed,
    SUM(CASE WHEN e.type='VERIFICATION_CORRECTION' THEN 1 ELSE 0 END) corrections,
    COALESCE(MAX(CASE WHEN e.type='ROUND_WIN' THEN e.amount END),0) largestWin,
    COALESCE(MIN(CASE WHEN e.type='ROUND_LOSS' THEN e.amount END),0) largestLoss,
    COALESCE(SUM(e.amount),0) ledgerBalance
    FROM BankAccount a LEFT JOIN BankEntry e ON e.accountId=a.id WHERE a.economy=? GROUP BY a.id ORDER BY a.name`, economy);
  const movements = l.rows("SELECT e.type,COUNT(*) count,SUM(e.amount) amount FROM BankEntry e JOIN BankAccount a ON a.id=e.accountId WHERE a.economy=? GROUP BY e.type", economy);
  const periods = l.rows("SELECT substr(e.createdAt,1,10) period,SUM(CASE WHEN type IN ('ROUND_WIN','ROUND_LOSS') THEN amount ELSE 0 END) net,SUM(CASE WHEN type='VERIFICATION_CORRECTION' THEN amount ELSE 0 END) corrections,SUM(amount) movement FROM BankEntry e JOIN BankAccount a ON a.id=e.accountId WHERE a.economy=? GROUP BY period ORDER BY period DESC LIMIT 90", economy);
  const streams = l.rows("SELECT stream,COUNT(DISTINCT reference) rounds,SUM(amount) net FROM BankEntry e JOIN BankAccount a ON a.id=e.accountId WHERE a.economy=? AND type IN ('ROUND_WIN','ROUND_LOSS') GROUP BY stream", economy);
  const issues: { severity: string; reference: string; reason: string }[] = [];
  for (const a of accounts) {
    if (a.balance !== a.ledgerBalance) issues.push({ severity: "CRITICAL", reference: String(a.id), reason: "Current balance does not equal the sum of ledger entries." });
    if (!a.known) issues.push({ severity: "WARNING", reference: String(a.id), reason: "Opening balance has not been verified." });
    if (!a.verifiedAt || Date.now() - Date.parse(String(a.verifiedAt)) > 86400000) issues.push({ severity: "WARNING", reference: String(a.id), reason: "External verification is older than 24 hours or missing." });
  }
  for (const r of l.rows("SELECT e.id FROM BankEntry e JOIN BankAccount a ON a.id=e.accountId WHERE a.economy=? AND e.beforeBalance != COALESCE((SELECT p.afterBalance FROM BankEntry p WHERE p.accountId=e.accountId AND p.id<e.id ORDER BY p.id DESC LIMIT 1),0) LIMIT 100", economy)) issues.push({ severity: "CRITICAL", reference: `entry:${r.id}`, reason: "Ledger before/after chain is broken." });
  for (const t of l.rows("SELECT t.* FROM BankTransfer t JOIN BankAccount a ON a.id=t.sender WHERE a.economy=? AND (t.status IN ('UNCERTAIN','SUBMITTED') OR (t.status='CONFIRMED' AND ((SELECT COUNT(*) FROM BankEntry WHERE reference=t.id)!=2 OR (SELECT SUM(amount) FROM BankEntry WHERE reference=t.id)!=0))) LIMIT 100", economy)) issues.push({ severity: t.status === "CONFIRMED" ? "CRITICAL" : "WARNING", reference: String(t.id), reason: t.status === "CONFIRMED" ? "Transfer ledger entries do not reconcile." : "External transfer outcome requires reconciliation; automatic resend is blocked." });
  for (const r of l.rows("SELECT * FROM BankRound WHERE economy=? AND (status!='POSTED' OR totalAfter!=totalBefore+gains-losses OR (SELECT COUNT(*) FROM BankParticipant WHERE roundId=BankRound.id)!=(SELECT COUNT(*) FROM BankEntry WHERE reference=BankRound.id)) ORDER BY createdAt DESC LIMIT 100", economy)) issues.push({ severity: r.status === "POSTED" ? "CRITICAL" : "WARNING", reference: String(r.id), reason: String(r.reason ?? "Round is awaiting results or reconciliation.") });
  const insights = accounts.map(a => {
    const n = Number(a.wins) + Number(a.losses), wins = Number(a.wins), net = Number(a.won) - Number(a.lost);
    const p = n ? wins / n : 0, z = 1.96, denominator = 1 + z*z / Math.max(1,n), center = (p + z*z/(2*Math.max(1,n))) / denominator, margin = z*Math.sqrt((p*(1-p)+z*z/(4*Math.max(1,n)))/Math.max(1,n))/denominator;
    return { accountId: a.id, observation: `${a.name}: ${net.toLocaleString()} net round points across ${n} posted rounds.`, evidence: `${wins} wins, ${a.losses} losses; ${a.sent} sent, ${a.received} received; ${a.corrections} verification corrections.`, implication: n < 20 ? "Small sample: no reliable performance ranking. Transfers are redistribution, not gains." : "Review the recorded period and stakes before comparing accounts. Observed performance does not predict future random outcomes.", winRate: n ? p : null, interval95: n ? [Math.max(0,center-margin),Math.min(1,center+margin)] : null };
  });
  const value = (type: string) => Number(movements.find(r => r.type === type)?.amount ?? 0);
  const totals = { balance: accounts.filter(a => a.known).reduce((s,a) => s+Number(a.balance),0), known: accounts.filter(a => a.known).length, accounts: accounts.length, gains: value("ROUND_WIN"), losses: -value("ROUND_LOSS"), net: value("ROUND_WIN")+value("ROUND_LOSS"), circulated: value("TRANSFER_RECEIVED")+value("ACCUMULATION_RECEIVED"), accumulated: value("ACCUMULATION_RECEIVED"), corrections: value("VERIFICATION_CORRECTION"), adjustments: value("ADJUSTMENT")+value("REVERSAL"), opening: value("OPENING"), wins: accounts.reduce((s,a)=>s+Number(a.wins),0), lossesCount: accounts.reduce((s,a)=>s+Number(a.losses),0), participants: accounts.filter(a=>Number(a.wins)+Number(a.losses)>0).length };
  return { totals, accounts, movements, periods, streams, insights, integrity: { status: issues.some(i=>i.severity==="CRITICAL") ? "CRITICAL" : issues.length ? "WARNING" : "HEALTHY", issues }, scope: "Posted ledger history since migration. Imported old history is archived and excluded from generated-point analytics. Daily chart shows the latest 90 recorded days." };
}
