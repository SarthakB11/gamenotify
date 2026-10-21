import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventId, InMemoryInbox, Notification, NotificationId, PlayerId } from '../src/index.ts';
import { FakeClock } from '../src/testing/index.ts';

let n = 0;
const note = (player: number, at = 0) =>
  Notification.create(NotificationId(`n${++n}`), at, {
    recipientId: PlayerId(player),
    type: 'LEVEL_UP',
    title: 't',
    message: `m${n}`,
    data: {},
    sourceEventId: EventId('e'),
  });

const make = (capacity = 5, ttlMs = 1e9) => {
  const clock = new FakeClock(0);
  return { inbox: new InMemoryInbox({ capacity, ttlMs, clock, epoch: 'ep' }), clock };
};

describe('InMemoryInbox', () => {
  it('assigns contiguous per-player seqs', () => {
    const { inbox } = make();
    expect(inbox.append(note(1), 'LIVE').seq).toBe(1);
    expect(inbox.append(note(2), 'LIVE').seq).toBe(1);
    expect(inbox.append(note(1), 'SILENT').seq).toBe(2);
    expect(inbox.lastSeq(PlayerId(1))).toBe(2);
    expect(inbox.lastSeq(PlayerId(9))).toBe(0);
    expect(inbox.epoch).toBe('ep');
  });

  it('since() returns entries after a cursor, or resync when the cursor fell out', () => {
    const { inbox } = make(3);
    for (let i = 0; i < 5; i++) inbox.append(note(1), 'LIVE'); // retains seq 3..5
    expect(inbox.since(PlayerId(1), 3, 10)).toMatchObject({ kind: 'entries', entries: [{ seq: 4 }, { seq: 5 }] });
    expect(inbox.since(PlayerId(1), 2, 10)).toMatchObject({ kind: 'entries', entries: [{ seq: 3 }, { seq: 4 }, { seq: 5 }] });
    expect(inbox.since(PlayerId(1), 1, 10)).toEqual({ kind: 'resync', oldestSeq: 3 });
    expect(inbox.since(PlayerId(1), 99, 10)).toEqual({ kind: 'resync', oldestSeq: 3 });
    expect(inbox.since(PlayerId(1), 2, 1)).toMatchObject({ kind: 'entries', entries: [{ seq: 3 }] });
    expect(inbox.since(PlayerId(7), 0, 10)).toEqual({ kind: 'entries', entries: [] });
    expect(inbox.since(PlayerId(7), 4, 10)).toEqual({ kind: 'resync', oldestSeq: 1 });
  });

  it('pages newest-first', () => {
    const { inbox } = make(10);
    for (let i = 0; i < 6; i++) inbox.append(note(1), 'LIVE');
    expect(inbox.page(PlayerId(1), null, 2).map((e) => e.seq)).toEqual([6, 5]);
    expect(inbox.page(PlayerId(1), 5, 3).map((e) => e.seq)).toEqual([4, 3, 2]);
    expect(inbox.page(PlayerId(9), null, 3)).toEqual([]);
  });

  it('tracks read state and unread counts across eviction', () => {
    const { inbox } = make(3);
    const a = inbox.append(note(1), 'LIVE');
    inbox.append(note(1), 'LIVE');
    expect(inbox.unreadCount(PlayerId(1))).toBe(2);
    expect(inbox.markRead(PlayerId(1), a.notification.id, 10)).toBe(true);
    expect(inbox.markRead(PlayerId(1), a.notification.id, 11)).toBe(true); // idempotent
    expect(inbox.find(PlayerId(1), a.notification.id)?.readAt).toBe(10);
    expect(inbox.unreadCount(PlayerId(1))).toBe(1);
    inbox.append(note(1), 'LIVE');
    inbox.append(note(1), 'LIVE'); // evicts seq 1 (already read)
    inbox.append(note(1), 'LIVE'); // evicts seq 2 (unread)
    expect(inbox.unreadCount(PlayerId(1))).toBe(3);
    expect(inbox.markAllRead(PlayerId(1), 4, 20)).toBe(2);
    expect(inbox.unreadCount(PlayerId(1))).toBe(1);
    expect(inbox.markRead(PlayerId(1), NotificationId('missing'), 1)).toBe(false);
    expect(inbox.markAllRead(PlayerId(42), 10, 1)).toBe(0);
    expect(inbox.unreadCount(PlayerId(42))).toBe(0);
  });

  it('prunes entries past the TTL lazily', () => {
    const { inbox, clock } = make(10, 1_000);
    inbox.append(note(1, 0), 'LIVE');
    clock.set(500);
    inbox.append(note(1, 500), 'LIVE');
    clock.set(1_200);
    expect(inbox.page(PlayerId(1), null, 10).map((e) => e.seq)).toEqual([2]);
    expect(inbox.since(PlayerId(1), 0, 10)).toEqual({ kind: 'resync', oldestSeq: 2 });
  });

  it('rejects zero capacity', () => {
    expect(() => new InMemoryInbox({ capacity: 0, ttlMs: 1, clock: new FakeClock() })).toThrow();
  });

  it('property: since(k) always returns exactly the retained seqs > k, in order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        (cap, appends, cursor) => {
          const { inbox } = make(cap);
          for (let i = 0; i < appends; i++) inbox.append(note(1), 'LIVE');
          const first = Math.max(1, appends - cap + 1);
          const r = inbox.since(PlayerId(1), cursor, 1_000);
          if (appends === 0) {
            expect(r.kind).toBe(cursor === 0 ? 'entries' : 'resync');
          } else if (cursor < first - 1 || cursor > appends) {
            expect(r.kind).toBe('resync');
          } else {
            expect(r.kind === 'entries' && r.entries.map((e) => e.seq)).toEqual(
              Array.from({ length: appends - cursor }, (_, i) => cursor + 1 + i),
            );
          }
        },
      ),
    );
  });

  it('grows its per-player ring on demand and keeps order through growth, wraparound and eviction', () => {
    const { inbox } = make(100);
    for (let i = 0; i < 250; i++) inbox.append(note(1), 'LIVE');
    const seqs = inbox.page(PlayerId(1), null, 1000).map((e) => e.seq);
    expect(seqs).toHaveLength(100);
    expect(seqs[0]).toBe(250);
    expect(seqs[99]).toBe(151);
    expect(inbox.since(PlayerId(1), 150, 1000)).toMatchObject({ kind: 'entries' });
    expect(inbox.unreadCount(PlayerId(1))).toBe(100);
  });

  it('grows correctly when the head has advanced after TTL pruning', () => {
    const { inbox, clock } = make(100, 10);
    for (let i = 0; i < 6; i++) inbox.append(note(1), 'LIVE');
    clock.advance(20);
    for (let i = 0; i < 40; i++) inbox.append(note(1, 20), 'LIVE'); // prunes the 6 old ones, then outgrows the initial ring
    expect(inbox.page(PlayerId(1), null, 1000).map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => 46 - i));
  });
});
