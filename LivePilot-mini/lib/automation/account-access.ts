type Waiter = { resolve: (release: () => void) => void; reject: (reason?: unknown) => void; signal: AbortSignal; abort: () => void };

class AccountAccessCoordinator {
  private locked = new Set<string>();
  private queues = new Map<string, Waiter[]>();

  async acquire(accountId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.locked.has(accountId)) { this.locked.add(accountId); return this.releaseFor(accountId); }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        const queue = this.queues.get(accountId);
        if (queue) this.queues.set(accountId, queue.filter(item => item !== waiter));
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      } };
      const queue = this.queues.get(accountId) ?? [];
      queue.push(waiter); this.queues.set(accountId, queue);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  async run<T>(accountId: string, signal: AbortSignal, work: () => Promise<T>) {
    const release = await this.acquire(accountId, signal);
    try { return await work(); } finally { release(); }
  }

  private releaseFor(accountId: string) {
    let released = false;
    return () => {
      if (released) return; released = true;
      const queue = this.queues.get(accountId) ?? [];
      while (queue.length) {
        const next = queue.shift()!; next.signal.removeEventListener("abort", next.abort);
        if (next.signal.aborted) continue;
        if (queue.length) this.queues.set(accountId, queue); else this.queues.delete(accountId);
        next.resolve(this.releaseFor(accountId)); return;
      }
      this.queues.delete(accountId); this.locked.delete(accountId);
    };
  }
}

const globalAccess = globalThis as unknown as { livepilotAccountAccess?: AccountAccessCoordinator };
export const accountAccess = globalAccess.livepilotAccountAccess ?? new AccountAccessCoordinator();
globalAccess.livepilotAccountAccess = accountAccess;
