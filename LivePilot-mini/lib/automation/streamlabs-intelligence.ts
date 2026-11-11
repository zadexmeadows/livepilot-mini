import type { ChatAnnouncement } from "./streamlabs-matcher";

export type BalanceMessage = { username: string; balance: number };
export type TransferMessage = { donor: string; recipient: string; amount: number; ok: boolean };
export type JoinMessage = { username: string };
export type HeistResultsMessage = { winners: { username: string; payout: number }[] };
export type RollMessage = { username: string; won: boolean; amount: number; balance: number };

const number = (value: string) => Number(value.replace(/[,_\s]/g, ""));

export function normalizeStreamlabsName(value: string) {
  return value.normalize("NFKC").trim().replace(/^@/, "").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function isStreamlabsMessage(message: ChatAnnouncement) {
  return normalizeStreamlabsName(message.author) === "streamlabs" && !!message.id;
}

export function parsePointsBalance(text: string): BalanceMessage | null {
  const match = text.normalize("NFKC").trim().match(/^@?(.+?),?\s+you have\s+([\d,_\s]+)\s+Points\.?$/i);
  if (!match) return null;
  return { username: match[1].trim(), balance: number(match[2]) };
}

export function parseTransfer(text: string): TransferMessage | null {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  const failed = normalized.match(/^(.+?)\s+failed to give\s+([\d,_\s]+)\s+Points to\s+(.+?)(?:\.\s*FeelsBadMan|\.|\s+FeelsBadMan)?$/i);
  if (failed) return { donor: failed[1].trim(), amount: number(failed[2]), recipient: failed[3].trim(), ok: false };
  const success = normalized.match(/^(.+?)\s+gave\s+([\d,_\s]+)\s+Points to\s+(.+?)\.?$/i);
  if (success) return { donor: success[1].trim(), amount: number(success[2]), recipient: success[3].trim(), ok: true };
  return null;
}

export function parseHeistJoin(text: string): JoinMessage | null {
  const match = text.normalize("NFKC").replace(/\s+/g, " ").trim().match(/^Ahoy!\s+@?(.+?)\s+has joined the treasure hunt\.?$/i);
  return match ? { username: match[1].trim() } : null;
}

export function parseHeistCaptain(text: string): JoinMessage | null {
  const match = text.normalize("NFKC").replace(/\s+/g, " ").trim().match(/^Ahoy!\s+Captain\s+(.+?)\s+is trying to get a crew together for a treasure hunt!/i);
  return match ? { username: match[1].trim() } : null;
}

export function parseHeistResults(text: string): HeistResultsMessage | null {
  const normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!/^Results:\s*/i.test(normalized)) return null;
  const winners = [...normalized.replace(/^Results:\s*/i, "").matchAll(/(?:^|,\s*)(.+?)\s*\(([\d,_\s]+)\)(?=,|$)/g)]
    .map(match => ({ username: match[1].trim(), payout: number(match[2]) }))
    .filter(item => item.username && Number.isFinite(item.payout));
  return winners.length ? { winners } : null;
}

export function parseRoll(text: string): RollMessage | null {
  const match = text.normalize("NFKC").replace(/\s+/g, " ").trim().match(/^Rolled\s+\d+,\s+@?(.+?)\s+(won|lost)\s+([\d,_\s]+)\s+Points and now has\s+([\d,_\s]+)\s+Points\.?$/i);
  if (!match) return null;
  return { username: match[1].trim(), won: match[2].toLowerCase() === "won", amount: number(match[3]), balance: number(match[4]) };
}

export function sameStreamlabsName(left: string, right: string) {
  return normalizeStreamlabsName(left) === normalizeStreamlabsName(right);
}
