import { EventId, NotificationId } from '../../domain/index.ts';
import type { Clock, IdGenerator, Logger, Metrics, Scheduler, TimerHandle } from '../../ports/index.ts';

export const systemClock: Clock = { now: () => Date.now() };

/** Timers are unref'd so pending grouping windows never keep the process alive. */
export const nodeScheduler: Scheduler = {
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { cancel: () => clearTimeout(t) };
  },
};

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * RFC 9562 UUIDv7: 48-bit Unix ms timestamp + 74 random bits. Time-ordered → B-tree/index friendly
 * when the inbox moves to Postgres. Uses the global Web Crypto API (no imports, no dependencies).
 * A monotonic counter in rand_a keeps ids strictly increasing within the same millisecond.
 */
export const createUuidV7 = (clock: Clock = systemClock): (() => string) => {
  // Random bytes are drawn from a pooled buffer: one getRandomValues call per 256 ids instead of per id.
  const pool = new Uint8Array(4096);
  let offset = pool.length;
  const bytes = new Uint8Array(16);
  let lastMs = -1;
  let counter = 0;
  return () => {
    let ms = clock.now();
    if (offset + 16 > pool.length) {
      crypto.getRandomValues(pool);
      offset = 0;
    }
    bytes.set(pool.subarray(offset, offset + 16));
    offset += 16;
    if (ms <= lastMs) {
      ms = lastMs;
      counter = (counter + 1) & 0xfff;
      if (counter === 0) ms = ++lastMs;
    } else {
      counter = ((bytes[6] as number) << 4) & 0x7ff; // random start, leaves headroom
      lastMs = ms;
    }
    bytes[0] = (ms / 2 ** 40) & 0xff;
    bytes[1] = (ms / 2 ** 32) & 0xff;
    bytes[2] = (ms >>> 24) & 0xff;
    bytes[3] = (ms >>> 16) & 0xff;
    bytes[4] = (ms >>> 8) & 0xff;
    bytes[5] = ms & 0xff;
    bytes[6] = 0x70 | ((counter >>> 8) & 0x0f); // version 7
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f); // RFC 4122 variant
    let s = '';
    for (let i = 0; i < 16; i++) {
      s += HEX[bytes[i] as number];
      if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
    }
    return s;
  };
};

export const uuidV7Ids = (clock: Clock = systemClock): IdGenerator => {
  const next = createUuidV7(clock);
  return { eventId: () => EventId(next()), notificationId: () => NotificationId(next()) };
};

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  isDebugEnabled: () => false,
};

export const noopMetrics: Metrics = { inc() {}, observe() {}, gauge() {} };
