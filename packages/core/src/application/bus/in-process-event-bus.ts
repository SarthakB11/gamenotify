import type { EventKind, EventOf, PlatformEvent } from '../../domain/index.ts';
import type { EventBus, EventHandler, Logger, Metrics, PublishResult, Unsubscribe } from '../../ports/index.ts';
import { RingBuffer } from './ring-buffer.ts';

export interface InProcessEventBusOptions {
  /** Max queued events (rounded up to a power of two). */
  readonly capacity: number;
  /** Max events processed per macrotask before yielding to I/O. */
  readonly batchSize: number;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

const EMPTY: readonly EventHandler[] = Object.freeze([]);

/**
 * Typed, bounded, non-blocking in-process pub/sub.
 *
 * - publish() never runs handlers synchronously: producers do not pay the consumers' cost.
 * - Events are processed strictly FIFO (preserves per-recipient ordering).
 * - Draining happens in batches on setImmediate, yielding between batches so sockets/timers stay responsive.
 * - A failing handler is logged and counted; it cannot affect other handlers or events.
 *
 * Chosen over Node's EventEmitter, which is synchronous, untyped and has no back-pressure.
 */
export class InProcessEventBus implements EventBus {
  readonly #queue: RingBuffer<PlatformEvent>;
  readonly #byKind = new Map<EventKind, readonly EventHandler[]>();
  #all: readonly EventHandler[] = EMPTY;
  readonly #batch: number;
  readonly #log: Logger;
  readonly #metrics: Metrics;
  #scheduled = false;
  #draining = false;
  #waiters: (() => void)[] = [];

  constructor(opts: InProcessEventBusOptions) {
    this.#queue = new RingBuffer(opts.capacity);
    this.#batch = Math.max(1, opts.batchSize);
    this.#log = opts.logger;
    this.#metrics = opts.metrics;
  }

  get depth(): number {
    return this.#queue.size;
  }

  publish(event: PlatformEvent): PublishResult {
    if (!this.#queue.push(event)) {
      this.#metrics.inc('bus_rejected_total', { kind: event.kind });
      return 'rejected';
    }
    this.#schedule();
    return 'accepted';
  }

  subscribe<K extends EventKind>(kind: K, handler: EventHandler<EventOf<K>>): Unsubscribe {
    const h = handler as EventHandler;
    // Copy-on-write: iteration in the drain loop is never affected by (un)subscribe.
    this.#byKind.set(kind, [...(this.#byKind.get(kind) ?? EMPTY), h]);
    return () => {
      this.#byKind.set(
        kind,
        (this.#byKind.get(kind) ?? EMPTY).filter((x) => x !== h),
      );
    };
  }

  subscribeAll(handler: EventHandler): Unsubscribe {
    this.#all = [...this.#all, handler];
    return () => {
      this.#all = this.#all.filter((x) => x !== handler);
    };
  }

  drain(): Promise<void> {
    if (this.#queue.size === 0 && !this.#draining) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(this.#drainTick);
  }

  readonly #drainTick = async (): Promise<void> => {
    this.#draining = true;
    let processed = 0;
    while (processed < this.#batch) {
      const event = this.#queue.shift();
      if (event === undefined) break;
      processed++;
      const specific = this.#byKind.get(event.kind) ?? EMPTY;
      const all = this.#all;
      if (specific.length + all.length === 1) {
        // Fast path (the common case): a single handler, no array/Promise.all allocation.
        await this.#invoke((specific[0] ?? all[0]) as EventHandler, event);
      } else {
        const tasks: Promise<void>[] = [];
        for (const h of specific) tasks.push(this.#invoke(h, event));
        for (const h of all) tasks.push(this.#invoke(h, event));
        await Promise.all(tasks);
      }
    }
    this.#metrics.gauge('bus_queue_depth', this.#queue.size);
    this.#draining = false;
    if (this.#queue.size > 0) {
      setImmediate(this.#drainTick); // yield to the event loop, then continue
      return;
    }
    this.#scheduled = false;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  };

  async #invoke(handler: EventHandler, event: PlatformEvent): Promise<void> {
    try {
      await handler(event);
    } catch (error) {
      this.#metrics.inc('bus_handler_errors_total', { kind: event.kind });
      this.#log.error({ err: error, eventId: event.eventId, kind: event.kind }, 'event handler failed');
    }
  }
}
