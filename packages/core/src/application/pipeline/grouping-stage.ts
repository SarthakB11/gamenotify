import { type NotificationIntent, NotificationType, type PlayerId } from '../../domain/index.ts';
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
  /** Held events whose actor is not the leading one (or has none). */
  heldOthers: number;
  readonly actors: PlayerId[];
  readonly distinct: Set<PlayerId>;
  last: NotificationIntent | null;
}

/** Bound on per-group distinct-actor tracking (memory safety under abuse). */
const MAX_DISTINCT = 10_000;

/**
 * The digest carries no delivery mode: held events do not latch one. The dispatcher decides it from the
 * preferences in force when the digest is emitted (a mute that ended inside the window must not leave it silent).
 */
export type GroupFlushHandler = (intent: NotificationIntent) => void;

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
  #absorbed = 0;

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

  /** Held events folded into the leading notification's actor (repeats) rather than counted in a digest. */
  get absorbedRepeats(): number {
    return this.#absorbed;
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
        heldOthers: 0,
        actors: [],
        distinct: new Set(),
        last: null,
      });
      this.#arm(key, this.#windowMs);
      return 'pass';
    }

    g.held++;
    g.last = intent;
    // The leading actor was already named by the delivered leading-edge notification, so the digest
    // counts and names only actors distinct from it.
    if (intent.actorId === undefined || intent.actorId !== g.leadingActorId) {
      g.heldOthers++;
      if (intent.actorId !== undefined && !g.distinct.has(intent.actorId)) {
        if (g.distinct.size < MAX_DISTINCT) g.distinct.add(intent.actorId);
        if (g.actors.length < this.#maxActors) g.actors.push(intent.actorId);
      }
    }
    g.windowEnd = Math.min(now + this.#windowMs, g.openedAt + this.#maxWindowMs);
    return 'held';
  }

  /** Forget a group whose leading-edge event failed, so a producer retry is a fresh leading edge. */
  cancel(key: string): void {
    const g = this.#groups.get(key);
    if (g !== undefined && g.held === 0) this.#groups.delete(key);
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
    const lead = g.leadingActorId;
    // Every held event repeats the leading actor.
    const repeatOnly = lead !== undefined && g.heldOthers === 0;
    if (repeatOnly && g.last.type === NotificationType.NEW_FOLLOWER) {
      this.#absorbed += g.held;
      return; // a repeat follow adds nothing new
    }
    if (g.held === 1 && !repeatOnly) {
      this.#onFlush(g.last);
      return;
    }
    const others = g.actors.length > 0;
    const groupCount = others && g.distinct.size === 1 ? g.heldOthers : g.held;
    this.#absorbed += g.held - groupCount;
    const out: NotificationIntent = {
      ...g.last,
      groupCount,
      actorIds: repeatOnly ? [lead] : [...g.actors],
      distinctActors: repeatOnly ? 1 : Math.max(1, g.distinct.size),
      ...(lead !== undefined ? { leadingActorId: lead } : {}),
    };
    this.#onFlush(out);
  }
}
