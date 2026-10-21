import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DeliveryMode,
  defaultPreferences,
  EventId,
  GroupingStage,
  type NotificationIntent,
  PlayerId,
  RateLimitStage,
  type StageContext,
  TokenBucketLimiter,
  TtlLruIdempotencyStore,
} from '../src/index.ts';
import { FakeClock, ManualScheduler, MemoryMetrics } from '../src/testing/index.ts';

describe('TtlLruIdempotencyStore', () => {
  it('dedups within the TTL and forgets after it', () => {
    const clock = new FakeClock(0);
    const s = new TtlLruIdempotencyStore({ ttlMs: 100, maxKeys: 10 }, clock);
    expect(s.firstSeen('a')).toBe(true);
    expect(s.firstSeen('a')).toBe(false);
    clock.advance(100);
    expect(s.firstSeen('a')).toBe(true);
  });

  it('is bounded by maxKeys (oldest evicted first)', () => {
    const s = new TtlLruIdempotencyStore({ ttlMs: 1e9, maxKeys: 3 }, new FakeClock(0));
    for (const k of ['a', 'b', 'c', 'd']) s.firstSeen(k);
    expect(s.size).toBe(3);
    expect(s.firstSeen('d')).toBe(false);
    expect(s.firstSeen('a')).toBe(true); // evicted, so seen as new
  });

  it('property: replaying any sequence never yields a second "first"', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 3 }), { maxLength: 200 }), (keys) => {
        // maxKeys only needs to exceed the 200-key bound: it sizes a ring buffer allocated per run (1e6 made each run
        // fill a 2^20-slot array, ~2s per property under load, which tripped the 5s test timeout).
        const s = new TtlLruIdempotencyStore({ ttlMs: 1e9, maxKeys: 1_024 }, new FakeClock(0));
        const firsts = keys.filter((k) => s.firstSeen(k));
        expect(new Set(firsts).size).toBe(firsts.length);
        expect(new Set(firsts)).toEqual(new Set(keys));
      }),
    );
  });
});

describe('TokenBucketLimiter / RateLimitStage', () => {
  it('allows a burst of `capacity`, then refills over time', () => {
    const clock = new FakeClock(0);
    const tb = new TokenBucketLimiter({ capacity: 3, refillWindowMs: 3_000, maxBuckets: 10 }, clock);
    expect([tb.take('k'), tb.take('k'), tb.take('k'), tb.take('k')]).toEqual([true, true, true, false]);
    clock.advance(1_000);
    expect([tb.take('k'), tb.take('k')]).toEqual([true, false]);
  });

  it('bounds tracked buckets', () => {
    const tb = new TokenBucketLimiter({ capacity: 1, refillWindowMs: 1_000, maxBuckets: 2 }, new FakeClock(0));
    tb.take('a');
    tb.take('b');
    tb.take('c');
    expect(tb.trackedKeys).toBe(2);
  });

  it('property: LIVE count over a window never exceeds capacity + refill', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 300 }), (gaps) => {
        const clock = new FakeClock(0);
        const cap = 5;
        const windowMs = 1_000;
        const stage = new RateLimitStage(
          new TokenBucketLimiter({ capacity: cap, refillWindowMs: windowMs, maxBuckets: 10 }, clock),
          new MemoryMetrics(),
        );
        let live = 0;
        for (const g of gaps) {
          clock.advance(g);
          const ctx = ctxFor('LEVEL_UP', clock.now());
          stage.apply(ctx);
          if (ctx.mode === DeliveryMode.LIVE) live++;
        }
        const elapsed = clock.now();
        expect(live).toBeLessThanOrEqual(cap + Math.floor((elapsed * cap) / windowMs) + 1);
      }),
    );
  });

  it('downgrades to SILENT (never drops) and exempts HIGH priority', () => {
    const clock = new FakeClock(0);
    const metrics = new MemoryMetrics();
    const stage = new RateLimitStage(
      new TokenBucketLimiter({ capacity: 1, refillWindowMs: 60_000, maxBuckets: 10 }, clock),
      metrics,
    );
    const a = ctxFor('LEVEL_UP', 0);
    const b = ctxFor('LEVEL_UP', 0);
    const c = ctxFor('PVP_ATTACKED', 0);
    expect([stage.apply(a), stage.apply(b), stage.apply(c)].every((v) => v.kind === 'continue')).toBe(true);
    expect([a.mode, b.mode, c.mode]).toEqual(['LIVE', 'SILENT', 'LIVE']);
    expect(metrics.count('rate_limited_total', { category: 'GAME' })).toBe(1);
  });
});

let seq = 0;
function ctxFor(type: NotificationIntent['type'], now: number, actor = 2, groupKey?: string): StageContext {
  return {
    intent: {
      recipientId: PlayerId(1),
      type,
      params: {},
      actorId: PlayerId(actor),
      sourceEventId: EventId(`e${++seq}`),
      occurredAt: now,
      ...(groupKey ? { groupKey } : {}),
    },
    prefs: defaultPreferences(PlayerId(1)),
    mode: DeliveryMode.LIVE,
    now,
  };
}

describe('GroupingStage (leading edge + trailing collapse)', () => {
  const make = (windowMs = 1_000, maxWindowMs = 5_000) => {
    const clock = new FakeClock(0);
    const scheduler = new ManualScheduler(clock);
    const g = new GroupingStage({ windowMs, maxWindowMs }, clock, scheduler);
    const flushed: { intent: NotificationIntent }[] = [];
    g.onFlush((intent) => flushed.push({ intent }));
    return { g, clock, scheduler, flushed };
  };

  it('passes non-groupable intents straight through', () => {
    const { g } = make();
    expect(g.offer(ctxFor('LEVEL_UP', 0))).toBe('pass');
  });

  it('passes the first, holds the rest and emits one aggregated intent', () => {
    const { g, clock, scheduler, flushed } = make();
    expect(g.offer(ctxFor('NEW_FOLLOWER', clock.now(), 2, 'k'))).toBe('pass');
    for (const actor of [3, 4, 5, 3]) {
      clock.advance(100);
      expect(g.offer(ctxFor('NEW_FOLLOWER', clock.now(), actor, 'k'))).toBe('held');
    }
    scheduler.advance(2_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.intent).toMatchObject({ groupCount: 4, actorIds: [3, 4, 5], distinctActors: 3 });
    expect(g.openGroups).toBe(0);
  });

  it('records the actor of the leading edge so digests can tell repeat attackers from new ones', () => {
    const { g, clock, scheduler, flushed } = make();
    g.offer(ctxFor('PVP_ATTACKED', clock.now(), 5, 'v'));
    for (let i = 0; i < 3; i++) g.offer(ctxFor('PVP_ATTACKED', clock.now(), 3, 'v'));
    scheduler.advance(2_000);
    expect(flushed[0]?.intent).toMatchObject({ groupCount: 3, actorIds: [3], distinctActors: 1, leadingActorId: 5 });
  });

  it('does not count the leading actor in the digest: Bram, Kael, Bram names only Kael', () => {
    const { g, clock, scheduler, flushed } = make();
    for (const actor of [2, 3, 2]) g.offer(ctxFor('NEW_FOLLOWER', clock.now(), actor, 'k'));
    scheduler.advance(2_000);
    expect(flushed[0]?.intent).toMatchObject({ actorIds: [3], distinctActors: 1, groupCount: 1, leadingActorId: 2 });
  });

  it('drops a follower digest made only of repeats of the leading actor', () => {
    const { g, clock, scheduler, flushed } = make();
    for (let i = 0; i < 3; i++) g.offer(ctxFor('NEW_FOLLOWER', clock.now(), 2, 'k'));
    scheduler.advance(2_000);
    expect(flushed).toHaveLength(0);
    expect(g.openGroups).toBe(0);
  });

  it('keeps a repeat-only PvP digest so it can say "more times"', () => {
    const { g, clock, scheduler, flushed } = make();
    for (let i = 0; i < 3; i++) g.offer(ctxFor('PVP_ATTACKED', clock.now(), 2, 'v'));
    scheduler.advance(2_000);
    expect(flushed[0]?.intent).toMatchObject({ groupCount: 2, actorIds: [2], distinctActors: 1, leadingActorId: 2 });
  });

  it('cancel() forgets a group that has held nothing, so the next event is a leading edge again', () => {
    const { g, clock } = make();
    expect(g.offer(ctxFor('NEW_FOLLOWER', clock.now(), 2, 'k'))).toBe('pass');
    g.cancel('k');
    expect(g.openGroups).toBe(0);
    expect(g.offer(ctxFor('NEW_FOLLOWER', clock.now(), 2, 'k'))).toBe('pass');
    g.offer(ctxFor('NEW_FOLLOWER', clock.now(), 3, 'k'));
    g.cancel('k'); // already holding events: must not be discarded
    expect(g.openGroups).toBe(1);
  });

  it('a single held intent is emitted as-is', () => {
    const { g, clock, scheduler, flushed } = make();
    g.offer(ctxFor('NEW_FOLLOWER', 0, 2, 'k'));
    g.offer(ctxFor('NEW_FOLLOWER', 0, 3, 'k'));
    scheduler.advance(1_000);
    expect(flushed[0]?.intent.groupCount).toBeUndefined();
    expect(flushed[0]?.intent.actorId).toBe(3);
    expect(clock.now()).toBe(1_000);
  });

  it('a window with no followers emits nothing', () => {
    const { g, scheduler, flushed } = make();
    g.offer(ctxFor('NEW_FOLLOWER', 0, 2, 'k'));
    scheduler.advance(5_000);
    expect(flushed).toHaveLength(0);
  });

  it('sliding window is capped at maxWindowMs', () => {
    const { g, clock, scheduler, flushed } = make(1_000, 3_000);
    g.offer(ctxFor('NEW_FOLLOWER', 0, 2, 'k'));
    for (let i = 0; i < 5; i++) {
      scheduler.advance(500); // keeps extending the sliding window ...
      g.offer(ctxFor('NEW_FOLLOWER', clock.now(), 3, 'k'));
    }
    expect(clock.now()).toBe(2_500);
    expect(flushed).toHaveLength(0);
    scheduler.advance(500); // ... but it closes at openedAt + maxWindowMs = 3000, not 3500
    expect(clock.now()).toBe(3_000);
    expect(flushed).toHaveLength(1);
  });

  it('flushAll emits open groups (graceful shutdown)', () => {
    const { g, flushed } = make();
    g.offer(ctxFor('NEW_FOLLOWER', 0, 2, 'k'));
    g.offer(ctxFor('NEW_FOLLOWER', 0, 3, 'k'));
    g.flushAll();
    expect(flushed).toHaveLength(1);
  });

  it('property: conservation — passed + Σ groupCount(flushed) + absorbed repeats = offered', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 3_000 }),
            key: fc.constantFrom('a', 'b'),
            actor: fc.integer({ min: 2, max: 9 }),
          }),
          {
            maxLength: 100,
          },
        ),
        (events) => {
          const { g, clock, scheduler, flushed } = make(1_000, 4_000);
          let passed = 0;
          for (const e of events) {
            scheduler.advance(e.gap);
            if (g.offer(ctxFor('NEW_FOLLOWER', clock.now(), e.actor, e.key)) === 'pass') passed++;
          }
          scheduler.advance(10_000);
          const grouped = flushed.reduce((n, f) => n + (f.intent.groupCount ?? 1), 0);
          expect(passed + grouped + g.absorbedRepeats).toBe(events.length);
        },
      ),
    );
  });
});
