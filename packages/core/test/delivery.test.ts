import { describe, expect, it } from 'vitest';
import {
  DeliveryRouter,
  EventId,
  exponentialBackoff,
  InAppChannel,
  type InboxEntry,
  InMemoryDeadLetterQueue,
  InMemoryInbox,
  InMemoryPreferenceRepository,
  Notification,
  NotificationId,
  PlayerId,
} from '../src/index.ts';
import { FakeClock, MemoryLogger, MemoryMetrics, RecordingSender } from '../src/testing/index.ts';

const entry = (): InboxEntry => ({
  seq: 1,
  mode: 'LIVE',
  deliveredAt: null,
  readAt: null,
  notification: Notification.create(NotificationId('n1'), 0, {
    recipientId: PlayerId(1),
    type: 'LEVEL_UP',
    title: 't',
    message: 'm',
    data: {},
    sourceEventId: EventId('e'),
  }),
});

const make = (sender: RecordingSender) => {
  const clock = new FakeClock(5);
  const inbox = new InMemoryInbox({ capacity: 10, ttlMs: 1e9, clock });
  const metrics = new MemoryMetrics();
  const dlq = new InMemoryDeadLetterQueue(2);
  const sleeps: number[] = [];
  const router = new DeliveryRouter({
    channels: [new InAppChannel(sender)],
    retry: exponentialBackoff({ maxAttempts: 3, baseMs: 50, capMs: 2_000 }, () => 0.5),
    dlq,
    prefs: new InMemoryPreferenceRepository(),
    inbox,
    clock,
    metrics,
    logger: new MemoryLogger(),
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { router, metrics, dlq, sleeps, inbox };
};

describe('DeliveryRouter', () => {
  it('records delivery through the inbox port, leaving the entry it was given untouched', async () => {
    const sender = new RecordingSender();
    const { router, inbox } = make(sender);
    const stored = inbox.append(entry().notification, 'LIVE');
    await router.deliver(stored);
    expect(stored.deliveredAt).toBeNull();
    expect(inbox.since(PlayerId(1), 0, 10)).toMatchObject({ entries: [{ seq: 1, deliveredAt: 5 }] });
  });

  it('delivers once on success', async () => {
    const sender = new RecordingSender();
    const { router, metrics } = make(sender);
    await router.deliver(entry());
    expect(sender.sent).toHaveLength(1);
    expect(metrics.count('notifications_delivered_total', { channel: 'in_app', result: 'DELIVERED' })).toBe(1);
  });

  it('does not retry an offline recipient (the inbox already has it)', async () => {
    const sender = new RecordingSender();
    sender.result = 'RECIPIENT_OFFLINE';
    const { router, sleeps, dlq } = make(sender);
    await router.deliver(entry());
    expect(sleeps).toEqual([]);
    expect(dlq.size).toBe(0);
  });

  it('retries failures with jittered exponential backoff, then dead-letters', async () => {
    const sender = new RecordingSender();
    sender.result = () => {
      throw new Error('socket hung up');
    };
    const { router, sleeps, dlq } = make(sender);
    await router.deliver(entry());
    expect(sleeps).toEqual([50, 100]); // 0.5 × 50·2^1, 0.5 × 50·2^2
    expect(dlq.list(10)).toMatchObject([{ channel: 'in_app', attempts: 3, error: 'socket hung up' }]);
  });

  it('recovers when a retry succeeds', async () => {
    const sender = new RecordingSender();
    let calls = 0;
    sender.result = () => (++calls < 2 ? 'FAILED' : 'DELIVERED');
    const { router, dlq } = make(sender);
    await router.deliver(entry());
    expect(sender.sent).toHaveLength(1);
    expect(dlq.size).toBe(0);
  });

  it('DLQ is bounded', () => {
    const dlq = new InMemoryDeadLetterQueue(2);
    for (let i = 0; i < 3; i++) dlq.put({ entry: entry(), channel: String(i), attempts: 1, at: i, error: '' });
    expect(dlq.list(10).map((d) => d.channel)).toEqual(['2', '1']);
  });

  it('backoff is capped', () => {
    const p = exponentialBackoff({ maxAttempts: 10, baseMs: 100, capMs: 1_000 }, () => 0.999);
    expect(p.delay(10)).toBeLessThan(1_000);
  });
});
