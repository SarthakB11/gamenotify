import { describe, expect, it } from 'vitest';
import {
  ConsoleNotificationSender,
  createUuidV7,
  EventId,
  InMemoryPlayerDirectory,
  Notification,
  NotificationId,
  nodeScheduler,
  noopLogger,
  PlayerId,
  SEED,
  uuidV7Ids,
} from '../src/index.ts';
import { FakeClock } from '../src/testing/index.ts';

describe('UUIDv7', () => {
  it('is RFC 9562 shaped and time-ordered, even within one millisecond', () => {
    const clock = new FakeClock(1_760_000_000_000);
    const next = createUuidV7(clock);
    const ids = Array.from({ length: 2_000 }, (_, i) => {
      if (i % 500 === 0) clock.advance(1);
      return next();
    });
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Number.parseInt(ids[0]!.replace(/-/g, '').slice(0, 12), 16)).toBe(1_760_000_000_001);
  });

  it('generator exposes branded ids', () => {
    const ids = uuidV7Ids();
    expect(ids.eventId()).not.toBe(ids.eventId());
    expect(ids.notificationId()).toHaveLength(36);
  });
});

describe('InMemoryPlayerDirectory', () => {
  it('lists every player in registration order and looks one up by id', () => {
    const dir = new InMemoryPlayerDirectory(SEED.players);
    expect(dir.list().map((p) => p.id)).toEqual(SEED.players.map((p) => p.id));
    expect(dir.get(SEED.players[0]!.id)).toBe(SEED.players[0]);
    expect(dir.get(PlayerId(9_999))).toBeUndefined();
  });
});

describe('system adapters', () => {
  it('scheduler fires and cancels', async () => {
    let fired = 0;
    nodeScheduler.setTimeout(() => fired++, 1);
    nodeScheduler.setTimeout(() => fired++, 1).cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(1);
    expect(noopLogger.isDebugEnabled()).toBe(false);
  });

  it('console sender prints an aligned line', () => {
    const lines: string[] = [];
    const sender = new ConsoleNotificationSender({
      write: (l) => lines.push(l),
      directory: new InMemoryPlayerDirectory(SEED.players),
    });
    const n = Notification.create(NotificationId('n'), 0, {
      recipientId: PlayerId(1),
      type: 'LEVEL_UP',
      title: 't',
      message: "Congratulations! You've reached level 15!",
      data: {},
      sourceEventId: EventId('e'),
    });
    expect(sender.send({ seq: 1, notification: n, mode: 'LIVE', deliveredAt: null, readAt: null })).toBe('DELIVERED');
    expect(lines[0]).toBe("→ #1 Aria   [GAME/LEVEL_UP]                Congratulations! You've reached level 15!");
  });
});
