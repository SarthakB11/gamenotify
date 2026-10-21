import { randomBytes } from 'node:crypto';
import type { PlayerId } from '@gamenotify/core';

export const DEFAULT_TICKET_TTL_MS = 30_000;
export const DEFAULT_MAX_TICKETS = 10_000;

/**
 * Short-lived, single-use stream tickets. `EventSource` cannot set headers, so the web client trades its
 * Bearer token for a ticket and puts only the ticket in the URL. A ticket is bound to one player, expires
 * after `ttlMs` and is consumed by its first use. Lookup is by 192-bit random id, so there is nothing to
 * compare in variable time. The store is bounded: expired entries are swept when it fills up, and issuing
 * fails (returns null) if it is still full of live tickets.
 */
export class StreamTicketStore {
  readonly #tickets = new Map<string, { readonly player: PlayerId; readonly expiresAt: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(ttlMs = DEFAULT_TICKET_TTL_MS, max = DEFAULT_MAX_TICKETS, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  get size(): number {
    return this.#tickets.size;
  }

  issue(player: PlayerId): string | null {
    const now = this.#now();
    if (this.#tickets.size >= this.#max) {
      for (const [id, t] of this.#tickets) if (t.expiresAt <= now) this.#tickets.delete(id);
      if (this.#tickets.size >= this.#max) return null;
    }
    const id = randomBytes(24).toString('base64url');
    this.#tickets.set(id, { player, expiresAt: now + this.#ttlMs });
    return id;
  }

  /** Atomically look up and delete; an expired, reused or unknown ticket yields null. */
  consume(id: string): PlayerId | null {
    const t = this.#tickets.get(id);
    if (!t) return null;
    this.#tickets.delete(id);
    return t.expiresAt > this.#now() ? t.player : null;
  }
}
