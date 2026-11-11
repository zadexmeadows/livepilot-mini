export type ChatAnnouncement = { id: string; author: string; text: string };

export function isHeistAnnouncement(message: ChatAnnouncement) {
  const author = message.author.normalize("NFKC").trim().replace(/^@/, "").toLowerCase();
  const text = message.text.normalize("NFKC").replace(/\s+/g, " ").trim();
  // Match the author's label, not somebody mentioning Streamlabs in a message.
  return !!message.id && author === "streamlabs" && /\b(?:ahoy|captain)\b/i.test(text)
    && /\bcrew\b/i.test(text) && /\btreasure\s+hunt\b/i.test(text)
    && /!heist\b/i.test(text) && /\bjoin\b/i.test(text);
}

export class AnnouncementTracker {
  private seen = new Set<string>();
  private seeded = false;

  resetBaseline() { this.seeded = false; }

  observe(messages: ChatAnnouncement[]) {
    const fresh: ChatAnnouncement[] = [];
    for (const message of messages) {
      if (!isHeistAnnouncement(message) || this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (this.seeded) fresh.push(message);
    }
    this.seeded = true;
    // Durable claims provide replay protection beyond this bounded memory cache.
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    return fresh;
  }
}
