import type { Clock } from '../../ports/index.ts';
import { RingBuffer } from '../bus/ring-buffer.ts';

export interface TokenBucketOptions {
  /** Burst size. */
  readonly capacity: number;
  /** Time to refill a full bucket from empty. */
  readonly refillWindowMs: number;
  /** Max tracked buckets (FIFO-evicted; an evicted bucket simply restarts full). */
  readonly maxBuckets: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

/**
 * Lazy-refill token bucket: no timers. take() refills based on elapsed time, then consumes one token.
 * Memory is bounded: buckets are evicted FIFO via a ring of keys (O(1)); an evicted bucket restarts full,
 * which only ever errs on the side of delivering.
 */
export class TokenBucketLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #order: RingBuffer<string>;
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #maxBuckets: number;
  readonly #clock: Clock;

  constructor(opts: TokenBucketOptions, clock: Clock) {
    if (opts.capacity < 1 || opts.refillWindowMs <= 0) throw new RangeError('invalid token bucket options');
    this.#capacity = opts.capacity;
    this.#refillPerMs = opts.capacity / opts.refillWindowMs;
    this.#maxBuckets = Math.max(1, opts.maxBuckets);
    this.#order = new RingBuffer(this.#maxBuckets);
    this.#clock = clock;
  }

  take(key: string): boolean {
    const now = this.#clock.now();
    let b = this.#buckets.get(key);
    if (b === undefined) {
      if (this.#buckets.size >= this.#maxBuckets) {
        const oldest = this.#order.shift();
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
      b = { tokens: this.#capacity, last: now };
      this.#buckets.set(key, b);
      this.#order.push(key);
    } else {
      b.tokens = Math.min(this.#capacity, b.tokens + (now - b.last) * this.#refillPerMs);
      b.last = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  get trackedKeys(): number {
    return this.#buckets.size;
  }
}
