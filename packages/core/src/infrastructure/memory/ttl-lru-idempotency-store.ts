import { RingBuffer } from '../../application/bus/ring-buffer.ts';
import type { Clock, IdempotencyStore } from '../../ports/index.ts';

export interface TtlLruOptions {
  readonly ttlMs: number;
  readonly maxKeys: number;
}

interface Slot {
  readonly key: string;
  readonly expiresAt: number;
}

/**
 * Bounded dedup window: Map for O(1) lookup + a FIFO ring of insertions for O(1) eviction.
 * Because the TTL is uniform, insertion order == expiry order, so the ring head is always the next to expire.
 *
 * Effective window: a key is remembered for min(ttlMs, maxKeys / arrival rate), because the ring evicts the oldest
 * key once maxKeys are held. At 100k events/s with the default 100k keys that is about 1 s, not the 10 min TTL.
 * Size it as maxKeys >= peak events per second x ttl seconds (per recipient key for fan-out events) to get the full TTL.
 *
 * (Deliberately not "iterate the Map from its head": V8 Maps keep tombstones for deleted entries,
 *  so head-iteration after many deletions degrades to O(n) per call — measured at ~70% of CPU.)
 */
export class TtlLruIdempotencyStore implements IdempotencyStore {
  readonly #keys = new Map<string, Slot>();
  readonly #order: RingBuffer<Slot>;
  readonly #ttl: number;
  readonly #max: number;
  readonly #clock: Clock;

  constructor(opts: TtlLruOptions, clock: Clock) {
    this.#ttl = opts.ttlMs;
    this.#max = Math.max(1, opts.maxKeys);
    this.#order = new RingBuffer(this.#max);
    this.#clock = clock;
  }

  get size(): number {
    return this.#keys.size;
  }

  firstSeen(key: string): boolean {
    const now = this.#clock.now();
    const current = this.#keys.get(key);
    if (current !== undefined && current.expiresAt > now) return false;

    this.#evictExpired(now);
    if (this.#order.size >= this.#max) this.#evictOne();
    const slot: Slot = { key, expiresAt: now + this.#ttl };
    this.#keys.set(key, slot);
    this.#order.push(slot);
    return true;
  }

  /**
   * The ring slot is left in place (it cannot be removed from the middle) and keeps counting toward maxKeys until
   * it reaches the head. Eviction deletes a key only when the Map still points at that very slot, so a stale slot
   * never evicts a re-inserted live key; the cost is at most one early eviction per released key.
   */
  release(key: string): void {
    this.#keys.delete(key);
  }

  #evictExpired(now: number): void {
    for (;;) {
      const head = this.#order.peek();
      if (head === undefined || head.expiresAt > now) return;
      this.#evictOne();
    }
  }

  #evictOne(): void {
    const slot = this.#order.shift();
    // Only delete if the Map still points at this slot (the key may have been released or re-inserted since).
    if (slot !== undefined && this.#keys.get(slot.key) === slot) this.#keys.delete(slot.key);
  }
}
