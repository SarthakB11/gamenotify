import { DeliveryMode, type NotificationIntent, type PlayerId } from '../../domain/index.ts';
import type { Clock, Scheduler } from '../../ports/index.ts';
import type { StageContext } from './stage.ts';

export interface GroupingOptions {
  /** Sliding window: each held event extends the window to now + windowMs ... */
  readonly windowMs: number;
  /** ... but never beyond openedAt + maxWindowMs. */
  readonly maxWindowMs: number;
  /** How many distinct actor ids to keep for rendering ("Kael, Mira and 2 others"). */
  readonly maxActors?: number;
}

interface Group {
  readonly openedAt: number;
  readonly leadingActorId: PlayerId | undefined;
  windowEnd: number;
  held: number;
  readonly actors: PlayerId[];
  readonly distinct: Set<PlayerId>;
  last: NotificationIntent | null;
  silent: boolean;
}

/** Bound on per-group distinct-actor tracking (memory safety under abuse). */
const MAX_DISTINCT = 10_000;

export type GroupFlushHandler = (intent: NotificationIntent, mode: DeliveryMode) => void;

/**
 * Leading-edge + trailing-collapse grouping for bursty types (followers, PvP attacks):
 *   - the first event of a burst passes through immediately (no added latency);
 *   - further events within the window are held and emitted once, as "X and N others ...".
 * Timers are re-armed lazily (never cleared) and unref'd by the scheduler.
 */
export class GroupingStage {
  readonly #groups = new Map<string, Group>();
  readonly #windowMs: number;
  readonly #maxWindowMs: number;
  readonly #maxActors: number;
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  #onFlush: GroupFlushHandler = () => {};

  constructor(opts: GroupingOptions, clock: Clock, scheduler: Scheduler) {
    if (opts.windowMs <= 0 || opts.maxWindowMs < opts.windowMs) throw new RangeError('invalid grouping windows');
    this.#windowMs = opts.windowMs;
    this.#maxWindowMs = opts.maxWindowMs;
    this.#maxActors = opts.maxActors ?? 3;
    this.#clock = clock;
    this.#scheduler = scheduler;
  }

  onFlush(handler: GroupFlushHandler): void {
    this.#onFlush = handler;
  }

  get openGroups(): number {
    return this.#groups.size;
  }

  /** 'pass' = continue now (leading edge or not groupable); 'held' = will be emitted in a trailing group. */
  offer(ctx: StageContext): 'pass' | 'held' {
    const { intent, now } = ctx;
    const key = intent.groupKey;
    if (key === undefined) return 'pass';

    const g = this.#groups.get(key);
    if (g === undefined) {
      this.#groups.set(key, {
        openedAt: now,
        leadingActorId: intent.actorId,
        windowEnd: now + this.#windowMs,
        held: 0,
        actors: [],
        distinct: new Set(),
        last: null,
        silent: false,
      });
      this.#arm(key, this.#windowMs);
      return 'pass';
    }

    g.held++;
    g.last = intent;
    if (intent.actorId !== undefined && !g.distinct.has(intent.actorId)) {
      if (g.distinct.size < MAX_DISTINCT) g.distinct.add(intent.actorId);
      if (g.actors.length < this.#maxActors) g.actors.push(intent.actorId);
    }
    g.windowEnd = Math.min(now + this.#windowMs, g.openedAt + this.#maxWindowMs);
    if (ctx.mode === DeliveryMode.SILENT) g.silent = true;
    return 'held';
  }

  /** Emit every open group immediately (graceful shutdown, tests). */
  flushAll(): void {
    for (const key of [...this.#groups.keys()]) this.#flush(key);
  }

  #arm(key: string, ms: number): void {
    this.#scheduler.setTimeout(() => {
      const g = this.#groups.get(key);
      if (g === undefined) return;
      const remaining = g.windowEnd - this.#clock.now();
      if (remaining > 0)
        this.#arm(key, remaining); // window was extended: re-arm lazily
      else this.#flush(key);
    }, ms);
  }

  #flush(key: string): void {
    const g = this.#groups.get(key);
    if (g === undefined) return;
    this.#groups.delete(key);
    if (g.held === 0 || g.last === null) return;
    const out: NotificationIntent =
      g.held === 1
        ? g.last
        : { ...g.last, groupCount: g.held, actorIds: [...g.actors], distinctActors: Math.max(1, g.distinct.size),
            ...(g.leadingActorId !== undefined ? { leadingActorId: g.leadingActorId } : {}),
          };
    this.#onFlush(out, g.silent ? DeliveryMode.SILENT : DeliveryMode.LIVE);
  }
}
