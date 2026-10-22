import { describe, expect, it } from 'vitest';
import type { DeliveryChannel, DeliveryResult } from '../src/index.ts';
import {
  DeliveryRouter,
  EventId,
  InAppChannel,
  type InboxEntry,
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

const make = (sender: RecordingSender, extra: readonly DeliveryChannel[] = []) => {
  const clock = new FakeClock(5);
  const inbox = new InMemoryInbox({ capacity: 10, ttlMs: 1e9, clock });
  const metrics = new MemoryMetrics();
  const logger = new MemoryLogger();
  const router = new DeliveryRouter({
    channels: [new InAppChannel(sender), ...extra],
    prefs: new InMemoryPreferenceRepository(),
    inbox,
    clock,
    metrics,
    logger,
  });
  return { router, metrics, logger, inbox };
};

const channel = (name: string, send: DeliveryChannel['send']): DeliveryChannel => ({ name, accepts: () => true, send });

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

  it('completes synchronously (no Promise) when every channel is synchronous', () => {
    const { router } = make(new RecordingSender());
    expect(router.deliver(entry())).toBeUndefined();
  });

  it('does not log or mark an offline recipient as failed (the inbox already has it)', async () => {
    const sender = new RecordingSender();
    sender.result = 'RECIPIENT_OFFLINE';
    const { router, logger, inbox, metrics } = make(sender);
    const stored = inbox.append(entry().notification, 'LIVE');
    await router.deliver(stored);
    expect(logger.lines).toEqual([]);
    expect(metrics.count('notifications_delivered_total', { channel: 'in_app', result: 'RECIPIENT_OFFLINE' })).toBe(1);
    expect(inbox.since(PlayerId(1), 0, 10)).toMatchObject({ entries: [{ seq: 1, deliveredAt: null }] });
  });

  it('counts and logs a FAILED result once, without retrying, and keeps the entry in the inbox', async () => {
    const sender = new RecordingSender();
    sender.result = () => 'FAILED';
    const { router, logger, inbox, metrics } = make(sender);
    const stored = inbox.append(entry().notification, 'LIVE');
    expect(router.deliver(stored)).toBeUndefined();
    expect(metrics.count('notifications_delivered_total', { channel: 'in_app', result: 'FAILED' })).toBe(1);
    expect(logger.lines).toMatchObject([{ level: 'warn', fields: { channel: 'in_app', playerId: 1, seq: 1 } }]);
    expect(inbox.since(PlayerId(1), 0, 10)).toMatchObject({ entries: [{ seq: 1, deliveredAt: null }] });
  });

  it('a throwing channel is logged with its error and does not stop the other channels', async () => {
    const sender = new RecordingSender();
    const boom = channel('boom', () => {
      throw new Error('socket hung up');
    });
    const { router, logger, metrics } = make(sender, [boom]);
    await router.deliver(entry());
    expect(sender.sent).toHaveLength(1);
    expect(metrics.count('notifications_delivered_total', { channel: 'boom', result: 'FAILED' })).toBe(1);
    expect(logger.lines).toMatchObject([
      { level: 'warn', fields: { channel: 'boom', playerId: 1, seq: 1, error: 'socket hung up' } },
    ]);
  });

  it('a rejecting async channel settles without rejecting and is counted as FAILED', async () => {
    const sender = new RecordingSender();
    const slow = channel('slow', () => Promise.reject(new Error('timeout')));
    const { router, logger, metrics } = make(sender, [slow]);
    await expect(router.deliver(entry())).resolves.toBeUndefined();
    expect(sender.sent).toHaveLength(1);
    expect(metrics.count('notifications_delivered_total', { channel: 'slow', result: 'FAILED' })).toBe(1);
    expect(logger.lines).toMatchObject([{ level: 'warn', fields: { channel: 'slow', error: 'timeout' } }]);
  });

  it('an async channel resolving FAILED is counted, an async DELIVERED marks the inbox', async () => {
    const sender = new RecordingSender();
    const results: DeliveryResult[] = ['FAILED', 'DELIVERED'];
    const asyncChannel = channel('async', () => Promise.resolve(results.shift() as DeliveryResult));
    const { router, metrics, inbox } = make(sender, [asyncChannel]);
    const stored = inbox.append(entry().notification, 'LIVE');
    await router.deliver(stored);
    expect(metrics.count('notifications_delivered_total', { channel: 'async', result: 'FAILED' })).toBe(1);
    await router.deliver(stored);
    expect(metrics.count('notifications_delivered_total', { channel: 'async', result: 'DELIVERED' })).toBe(1);
    expect(inbox.since(PlayerId(1), 0, 10)).toMatchObject({ entries: [{ seq: 1, deliveredAt: 5 }] });
  });
});
