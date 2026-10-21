import { randomBytes } from 'node:crypto';
import type { PlayerId } from '@gamenotify/core';

export const DEFAULT_TICKET_TTL_MS = 30_000;
export const DEFAULT_MAX_TICKETS = 10_000;
export const DEFAULT_MAX_TICKETS_PER_PLAYER = 5;

/**
 * Short-lived, single-use stream tickets. `EventSource` cannot set headers, so the web client trades its
 * Bearer token for a ticket and puts only the ticket in the URL. A ticket is bound to one player, expires
 * after `ttlMs` and is consumed by its first use. Lookup is by 192-bit random id, so there is nothing to
 * compare in variable time. The store is bounded: expired entries are swept when it fills up, and issuing
 * fails (returns null) if it is still full of live tickets.
 *
 * Each player may hold at most `maxPerPlayer` live tickets. Issuing beyond that evicts the player's oldest
 * ticket instead of failing: a reconnecting client always wants the newest ticket, and the older ones belong
 * to attempts it abandoned, so the reconnect keeps working while one logged-in player can no longer fill the
 * global store and lock everyone else out.
 */
export class StreamTicketStore {
  readonly #tickets = new Map<string, { readonly player: PlayerId; readonly expiresAt: number }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #maxPerPlayer: number;
  /** Live ticket ids per player, oldest first (at most `maxPerPlayer` each). */
  readonly #byPlayer = new Map<PlayerId, string[]>();
  readonly #now: () => number;

  constructor(
    ttlMs = DEFAULT_TICKET_TTL_MS,
    max = DEFAULT_MAX_TICKETS,
    now: () => number = Date.now,
    maxPerPlayer = DEFAULT_MAX_TICKETS_PER_PLAYER,
  ) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#maxPerPlayer = Math.max(1, maxPerPlayer);
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
      for (const [id, t] of this.#tickets) if (t.expiresAt <= now) this.#remove(id, t.player);
      if (this.#tickets.size >= this.#max) return null;
    }
    const mine = this.#byPlayer.get(player) ?? [];
    while (mine.length >= this.#maxPerPlayer) this.#tickets.delete(mine.shift() as string);
    const id = randomBytes(24).toString('base64url');
    this.#tickets.set(id, { player, expiresAt: now + this.#ttlMs });
    mine.push(id);
    this.#byPlayer.set(player, mine);
    return id;
  }

  /** Atomically look up and delete; an expired, reused or unknown ticket yields null. */
  consume(id: string): PlayerId | null {
    const t = this.#tickets.get(id);
    if (!t) return null;
    this.#remove(id, t.player);
    return t.expiresAt > this.#now() ? t.player : null;
  }

  #remove(id: string, player: PlayerId): void {
    this.#tickets.delete(id);
    const mine = this.#byPlayer.get(player);
    if (mine === undefined) return;
    const i = mine.indexOf(id);
    if (i >= 0) mine.splice(i, 1);
    if (mine.length === 0) this.#byPlayer.delete(player);
  }
}
