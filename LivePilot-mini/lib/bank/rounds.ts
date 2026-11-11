import { randomUUID } from "node:crypto";
import { Ledger, points } from "./ledger";
import { normalizeStreamlabsName, parseHeistCaptain, parseHeistJoin, parseHeistResults, isStreamlabsMessage } from "../automation/streamlabs-intelligence";
import type { ChatAnnouncement } from "../automation/streamlabs-matcher";

export class RoundService {
  private ledger: Ledger;
  constructor(ledger: Ledger) { this.ledger = ledger; }
  observe(stream: string, economy: string, message: ChatAnnouncement, confirmedStake?: number) {
    if (!isStreamlabsMessage(message)) return;
    const captain = parseHeistCaptain(message.text), joined = parseHeistJoin(message.text), result = parseHeistResults(message.text);
    if (!captain && !joined && !result) return;
    if (confirmedStake !== undefined) points(confirmedStake, 1);
    let autoPost: { id: string; evidence: { accountId:string;stake:number;payout:number }[] } | undefined;
    this.ledger.atomic(() => {
      const l = this.ledger, timestamp = new Date().toISOString();
      if (captain) {
        l.run("INSERT OR IGNORE INTO BankRound(id,economy,stream,announcementId,status,raw,createdAt,updatedAt) VALUES(?,?,?,?,'OPEN',?,?,?)", randomUUID(), economy, stream, message.id, JSON.stringify({ announcement: message }), timestamp, timestamp);
      }
      const round = captain ? l.one("SELECT * FROM BankRound WHERE stream=? AND announcementId=?", stream, message.id) : l.one("SELECT * FROM BankRound WHERE stream=? AND status='OPEN' ORDER BY createdAt DESC LIMIT 1", stream);
      if (!round) {
        if (result) l.run("INSERT OR IGNORE INTO BankRound(id,economy,stream,announcementId,resultId,status,raw,reason,createdAt,updatedAt) VALUES(?,?,?,?,?,'REVIEW',?,'Result observed without a complete participant capture',?,?)", randomUUID(), economy, stream, `orphan:${message.id}`, message.id, JSON.stringify({ result: message }), timestamp, timestamp);
        return;
      }
      const name = captain?.username ?? joined?.username;
      if (name && round.status === "OPEN") {
        const account = l.rows("SELECT * FROM BankAccount WHERE economy=?", economy).find(a => normalizeStreamlabsName(String(a.handle)) === normalizeStreamlabsName(name));
        if (account) l.run("INSERT OR IGNORE INTO BankParticipant(roundId,accountId,stake,version,beforeBalance) VALUES(?,?,?,?,?)", String(round.id), String(account.id), confirmedStake ?? null, Number(account.version), account.known ? Number(account.balance) : null);
      }
      if (result) {
        if (l.one("SELECT id FROM BankRound WHERE resultId=?", message.id)) return;
        const raw = { ...JSON.parse(String(round.raw)), result: message, winners: result.winners };
        for (const p of l.rows("SELECT p.*,a.handle FROM BankParticipant p JOIN BankAccount a ON a.id=p.accountId WHERE roundId=?", String(round.id))) {
          const winner = result.winners.find(w => normalizeStreamlabsName(w.username) === normalizeStreamlabsName(String(p.handle)));
          l.run("UPDATE BankParticipant SET payout=?,outcome=? WHERE roundId=? AND accountId=?", winner?.payout ?? 0, winner && winner.payout > 0 ? "WON" : "LOST", String(round.id), String(p.accountId));
        }
        l.run("UPDATE BankRound SET resultId=?,status='REVIEW',raw=?,reason='Confirm participant completeness and actual stakes before posting',updatedAt=? WHERE id=?", message.id, JSON.stringify(raw), timestamp, String(round.id));
        l.audit("ROUND_CAPTURED", String(round.id), "Results captured; stake/completeness review required", raw, "STREAMLABS");
        const captured=l.rows("SELECT * FROM BankParticipant WHERE roundId=?",String(round.id));
        if(captured.length&&captured.every(p=>p.stake!==null&&p.beforeBalance!==null)) autoPost={id:String(round.id),evidence:captured.map(p=>({accountId:String(p.accountId),stake:Number(p.stake),payout:Number(p.payout||0)}))};
      }
    });
    if(autoPost) try {
      this.reconcile(autoPost.id,autoPost.evidence,"Automatically posted from captured participants, configured wager, and the unique Streamlabs result message",`result:${message.id}`);
    } catch(error) {
      const reason=error instanceof Error?error.message:String(error);
      this.ledger.atomic(()=>{this.ledger.run("UPDATE BankRound SET status='REVIEW',reason=?,updatedAt=? WHERE id=?",`Automatic posting paused: ${reason}`,new Date().toISOString(),autoPost!.id);this.ledger.audit("ROUND_REVIEW_REQUIRED",autoPost!.id,reason,{resultId:message.id},"SYSTEM");});
    }
  }
  reconcile(id: string, evidence: { accountId: string; stake: number; payout: number }[], reason: string, requestKey: string) {
    const l = this.ledger;
    return l.atomic(() => {
      const round = l.one("SELECT * FROM BankRound WHERE id=?", id);
      if (!round || !round.resultId) throw new Error("A result must be captured before reconciliation.");
      if (round.status === "POSTED") return round;
      if (!reason.trim() || !evidence.length || new Set(evidence.map(p => p.accountId)).size !== evidence.length) throw new Error("Provide complete, unique participant evidence and a reason.");
      const captured = l.rows("SELECT * FROM BankParticipant WHERE roundId=?", id);
      if (captured.some(p => !evidence.some(e => e.accountId === p.accountId))) throw new Error("Every captured participant must be included.");
      const parsed = JSON.parse(String(round.raw)) as { winners?: {username:string;payout:number}[] };
      let before = 0, gains = 0, losses = 0;
      for (const item of evidence) {
        points(item.stake, 1); points(item.payout);
        const a = l.account(item.accountId); l.assertAvailable(item.accountId);
        if (!a.known || a.economy !== round.economy) throw new Error("Participants need known balances in this economy.");
        const p = captured.find(x => x.accountId === item.accountId);
        if (!p || Number(a.version) !== Number(p.version)) throw new Error("Balance changed since participation or participant snapshot is missing. Verify current balances; this historical result cannot be safely replayed.");
        const winner = parsed.winners?.find(w => normalizeStreamlabsName(w.username) === normalizeStreamlabsName(String(a.handle)));
        if ((winner?.payout ?? 0) !== item.payout) throw new Error("Payout must match the captured Streamlabs result.");
        const net = item.payout - item.stake, after = points(Number(a.balance) + net);
        before += Number(a.balance); gains += Math.max(0, net); losses += Math.max(0, -net);
        l.run("INSERT INTO BankEntry(eventKey,accountId,amount,beforeBalance,afterBalance,type,source,reference,stream,reason,actor,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", `round:${id}:${item.accountId}`, item.accountId, net, Number(a.balance), after, item.payout > 0 ? "ROUND_WIN" : "ROUND_LOSS", "STREAMLABS", id, String(round.stream), reason, "administrator", new Date().toISOString());
        l.run("UPDATE BankAccount SET balance=?,version=version+1,updatedAt=? WHERE id=?", after, new Date().toISOString(), item.accountId);
        l.run("UPDATE BankParticipant SET stake=?,payout=?,afterBalance=?,outcome=? WHERE roundId=? AND accountId=?", item.stake, item.payout, after, item.payout > 0 ? "WON" : "LOST", id, item.accountId);
      }
      l.run("UPDATE BankRound SET status='POSTED',totalBefore=?,gains=?,losses=?,totalAfter=?,reason=?,updatedAt=? WHERE id=?", before, gains, losses, before + gains - losses, reason, new Date().toISOString(), id);
      l.audit("ROUND_POSTED", id, reason, { requestKey, evidence, before, gains, losses, after: before + gains - losses });
      return l.one("SELECT * FROM BankRound WHERE id=?", id)!;
    });
  }
}
