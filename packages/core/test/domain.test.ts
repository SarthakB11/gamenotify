import { describe, expect, it } from 'vitest';
import {
  ALL_NOTIFICATION_TYPES,
  defaultPreferences,
  EventId,
  ItemId,
  ItemRarity,
  isValidTimeZone,
  Notification,
  NotificationId,
  PlayerId,
  parseClockTime,
  parseRarity,
  rarityName,
  TYPE_META,
} from '../src/index.ts';

const props = {
  recipientId: PlayerId(1),
  type: 'LEVEL_UP' as const,
  title: 'Level Up!',
  message: "Congratulations! You've reached level 15!",
  data: { level: 15 },
  sourceEventId: EventId('e1'),
};

describe('Notification', () => {
  it('derives category and priority from the type and is immutable', () => {
    const n = Notification.create(NotificationId('n1'), 1_000, props);
    expect(n.category).toBe('GAME');
    expect(n.priority).toBe(TYPE_META.LEVEL_UP.priority);
    expect(n.groupCount).toBe(1);
    expect(n.groupKey).toBeNull();
    expect(Object.isFrozen(n)).toBe(true);
    expect(() => {
      (n as unknown as { message: string }).message = 'x';
    }).toThrow();
  });

  it('serializes to a stable DTO', () => {
    const n = Notification.create(NotificationId('n1'), Date.UTC(2026, 0, 1), props);
    expect(n.toJSON()).toMatchObject({ id: 'n1', recipientId: 1, type: 'LEVEL_UP', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(JSON.parse(JSON.stringify(n)).message).toBe(props.message);
  });

  it('rejects invalid content', () => {
    expect(() => Notification.create(NotificationId('n'), 0, { ...props, message: '' })).toThrow(RangeError);
    expect(() => Notification.create(NotificationId('n'), 0, { ...props, message: 'x'.repeat(281) })).toThrow(RangeError);
    expect(() => Notification.create(NotificationId('n'), 0, { ...props, title: '' })).toThrow(RangeError);
    expect(() => Notification.create(NotificationId('n'), 0, { ...props, groupCount: 0 })).toThrow(RangeError);
  });
});

describe('ids and value objects', () => {
  it('validates player and item ids', () => {
    expect(PlayerId(7)).toBe(7);
    expect(() => PlayerId(0)).toThrow();
    expect(() => PlayerId(1.5)).toThrow();
    expect(() => ItemId('')).toThrow();
  });

  it('every notification type has metadata', () => {
    for (const t of ALL_NOTIFICATION_TYPES) expect(TYPE_META[t]).toBeDefined();
  });

  it('parses clock times, rarities and time zones', () => {
    expect(parseClockTime('22:30')).toBe(1350);
    expect(() => parseClockTime('24:00')).toThrow();
    expect(parseRarity('epic')).toBe(ItemRarity.EPIC);
    expect(() => parseRarity('mythic')).toThrow();
    expect(rarityName(ItemRarity.LEGENDARY)).toBe('LEGENDARY');
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('defaults enable everything', () => {
    const p = defaultPreferences(PlayerId(1));
    expect(p.categories).toEqual({ GAME: true, SOCIAL: true });
    expect(p.mutedUntil).toBeNull();
  });
});
