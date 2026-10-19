import { describe, expect, it, vi } from 'vitest';
import { EventId, InProcessEventBus, type PlatformEvent, PlayerId, RingBuffer } from '../src/index.ts';
import { MemoryLogger, MemoryMetrics } from '../src/testing/index.ts';

const lvl = (i: number): PlatformEvent => ({
  kind: 'game.player_leveled_up',
  eventId: EventId(`e${i}`),
  occurredAt: i,
  playerId: PlayerId(1),
  newLevel: i + 1,
});

const makeBus = (capacity = 16, batchSize = 4) => {
  const metrics = new MemoryMetrics();
  const logger = new MemoryLogger();
  return { bus: new InProcessEventBus({ capacity, batchSize, logger, metrics }), metrics, logger };
};

describe('RingBuffer', () => {
  it('is FIFO, bounded and rounds capacity to a power of two', () => {
    const r = new RingBuffer<number>(3);
    expect(r.capacity).toBe(4);
    for (let i = 0; i < 4; i++) expect(r.push(i)).toBe(true);
    expect(r.push(99)).toBe(false);
    expect([r.shift(), r.shift()]).toEqual([0, 1]);
    r.push(4);
    r.push(5);
    expect([r.shift(), r.shift(), r.shift(), r.shift(), r.shift()]).toEqual([2, 3, 4, 5, undefined]);
    expect(r.size).toBe(0);
  });

  it('rejects invalid capacity', () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});

describe('InProcessEventBus', () => {
  it('never runs handlers synchronously inside publish()', async () => {
    const { bus } = makeBus();
    const seen: number[] = [];
    bus.subscribeAll((e) => void seen.push(e.occurredAt));
    bus.publish(lvl(1));
    expect(seen).toEqual([]);
    await bus.drain();
    expect(seen).toEqual([1]);
  });

  it('preserves FIFO order across batches', async () => {
    const { bus } = makeBus(64, 3);
    const seen: number[] = [];
    bus.subscribe('game.player_leveled_up', (e) => void seen.push(e.occurredAt));
    for (let i = 0; i < 20; i++) bus.publish(lvl(i));
    await bus.drain();
    expect(seen).toEqual([...Array(20).keys()]);
  });

  it('applies back-pressure when full', () => {
    const { bus, metrics } = makeBus(4);
    const results = [1, 2, 3, 4, 5].map((i) => bus.publish(lvl(i)));
    expect(results).toEqual(['accepted', 'accepted', 'accepted', 'accepted', 'rejected']);
    expect(bus.depth).toBe(4);
    expect(metrics.count('bus_rejected_total', { kind: 'game.player_leveled_up' })).toBe(1);
  });

  it('isolates failing handlers', async () => {
    const { bus, logger, metrics } = makeBus();
    const ok = vi.fn();
    bus.subscribe('game.player_leveled_up', () => {
      throw new Error('boom');
    });
    bus.subscribeAll(ok);
    bus.publish(lvl(1));
    bus.publish(lvl(2));
    await bus.drain();
    expect(ok).toHaveBeenCalledTimes(2);
    expect(metrics.count('bus_handler_errors_total', { kind: 'game.player_leveled_up' })).toBe(2);
    expect(logger.lines.filter((l) => l.level === 'error')).toHaveLength(2);
  });

  it('supports unsubscribe and only routes matching kinds', async () => {
    const { bus } = makeBus();
    const lv = vi.fn();
    const follow = vi.fn();
    const off = bus.subscribe('game.player_leveled_up', lv);
    bus.subscribe('social.player_followed', follow);
    bus.publish(lvl(1));
    await bus.drain();
    off();
    bus.publish(lvl(2));
    await bus.drain();
    expect(lv).toHaveBeenCalledTimes(1);
    expect(follow).not.toHaveBeenCalled();
  });

  it('drain() resolves immediately when idle', async () => {
    const { bus } = makeBus();
    await expect(bus.drain()).resolves.toBeUndefined();
  });
});
