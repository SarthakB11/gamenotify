import { describe, expect, it } from 'vitest';
import {
  ALL_EVENT_KINDS,
  ChallengeCompletedResolver,
  ChallengeId,
  EventId,
  FriendAcceptedResolver,
  FriendRequestResolver,
  InMemoryContentCatalog,
  ItemAcquiredResolver,
  ItemId,
  ItemRarity,
  LevelUpResolver,
  NewFollowerResolver,
  PlayerId,
  PvpAttackedResolver,
  PvpDefeatedResolver,
  ResolverRegistry,
  SEED,
} from '../src/index.ts';
import { MemoryLogger, MemoryMetrics } from '../src/testing/index.ts';

const base = { eventId: EventId('e1'), occurredAt: 1 };
const P = PlayerId;
const catalog = new InMemoryContentCatalog(SEED.items, SEED.challenges);

describe('game resolvers', () => {
  it('level up → the player', () => {
    const [i] = new LevelUpResolver().resolve({ ...base, kind: 'game.player_leveled_up', playerId: P(1), newLevel: 15 });
    expect(i).toMatchObject({ recipientId: 1, type: 'LEVEL_UP', params: { level: 15 }, sourceEventId: 'e1' });
  });

  it('item acquired applies the rarity gate (rare and above)', () => {
    const metrics = new MemoryMetrics();
    const r = new ItemAcquiredResolver(catalog, ItemRarity.RARE, metrics);
    const ev = (id: string) => ({ ...base, kind: 'game.item_acquired' as const, playerId: P(2), itemId: ItemId(id) });
    expect(r.resolve(ev('SwordOfAzeroth'))[0]).toMatchObject({ type: 'ITEM_ACQUIRED', params: { itemId: 'SwordOfAzeroth' } });
    expect(r.resolve(ev('MoonstoneAmulet'))[0]).toMatchObject({ type: 'ITEM_ACQUIRED' });
    expect(r.resolve(ev('IronShield'))[0]).toMatchObject({ skip: 'BELOW_RARITY_THRESHOLD' });
    expect(r.resolve(ev('RustyDagger'))[0]).toMatchObject({ skip: 'BELOW_RARITY_THRESHOLD' });
    // Unknown items fail open and are counted.
    expect(r.resolve(ev('MysteryBox'))[0]).toMatchObject({ type: 'ITEM_ACQUIRED' });
    expect(metrics.count('catalog_miss_total', { kind: 'item' })).toBe(1);
  });

  it('challenge completed → the player', () => {
    const [i] = new ChallengeCompletedResolver().resolve({
      ...base,
      kind: 'game.challenge_completed',
      playerId: P(6),
      challengeId: ChallengeId('DragonsLair'),
    });
    expect(i).toMatchObject({ recipientId: 6, type: 'CHALLENGE_COMPLETED' });
  });

  it('pvp attack → victim, groupable; self-attack skipped', () => {
    const r = new PvpAttackedResolver();
    expect(r.resolve({ ...base, kind: 'game.pvp_attacked', attackerId: P(5), victimId: P(6) })[0]).toMatchObject({
      recipientId: 6,
      actorId: 5,
      groupKey: 'PVP_ATTACKED:6',
    });
    expect(r.resolve({ ...base, kind: 'game.pvp_attacked', attackerId: P(5), victimId: P(5) })[0]).toMatchObject({
      skip: 'SELF_ACTION',
    });
  });

  it('pvp defeat fans out to both players', () => {
    const out = new PvpDefeatedResolver().resolve({ ...base, kind: 'game.pvp_defeated', winnerId: P(5), loserId: P(4) });
    expect(out).toEqual([
      expect.objectContaining({ recipientId: 4, type: 'PVP_DEFEATED', actorId: 5 }),
      expect.objectContaining({ recipientId: 5, type: 'PVP_VICTORY', actorId: 4 }),
    ]);
    expect(
      new PvpDefeatedResolver().resolve({ ...base, kind: 'game.pvp_defeated', winnerId: P(4), loserId: P(4) })[0],
    ).toMatchObject({ skip: 'SELF_ACTION' });
  });
});

describe('social resolvers', () => {
  it('friend request → recipient', () => {
    const [i] = new FriendRequestResolver().resolve({
      ...base,
      kind: 'social.friend_request_sent',
      senderId: P(3),
      recipientId: P(1),
    });
    expect(i).toMatchObject({ recipientId: 1, actorId: 3, type: 'FRIEND_REQUEST' });
  });

  it('friend accepted → original requester', () => {
    const [i] = new FriendAcceptedResolver().resolve({
      ...base,
      kind: 'social.friend_request_accepted',
      accepterId: P(1),
      requesterId: P(3),
    });
    expect(i).toMatchObject({ recipientId: 3, actorId: 1, type: 'FRIEND_ACCEPTED' });
  });

  it('new follower → followee, groupable', () => {
    const [i] = new NewFollowerResolver().resolve({
      ...base,
      kind: 'social.player_followed',
      followerId: P(2),
      followeeId: P(1),
    });
    expect(i).toMatchObject({ recipientId: 1, actorId: 2, groupKey: 'NEW_FOLLOWER:1' });
  });

  it('self actions are skipped', () => {
    expect(
      new FriendRequestResolver().resolve({ ...base, kind: 'social.friend_request_sent', senderId: P(1), recipientId: P(1) })[0],
    ).toMatchObject({ skip: 'SELF_ACTION' });
    expect(
      new FriendAcceptedResolver().resolve({
        ...base,
        kind: 'social.friend_request_accepted',
        accepterId: P(1),
        requesterId: P(1),
      })[0],
    ).toMatchObject({ skip: 'SELF_ACTION' });
    expect(
      new NewFollowerResolver().resolve({ ...base, kind: 'social.player_followed', followerId: P(1), followeeId: P(1) })[0],
    ).toMatchObject({ skip: 'SELF_ACTION' });
  });
});

describe('ResolverRegistry', () => {
  it('rejects duplicates, detects missing kinds, and warns on unknown events', () => {
    const logger = new MemoryLogger();
    const reg = new ResolverRegistry(logger).register(new LevelUpResolver());
    expect(() => reg.register(new LevelUpResolver())).toThrow(/Duplicate/);
    expect(() => reg.assertComplete(ALL_EVENT_KINDS)).toThrow(/Missing resolvers/);
    expect(reg.resolve({ ...base, kind: 'social.player_followed', followerId: P(1), followeeId: P(2) })).toEqual([]);
    expect(logger.lines[0]?.level).toBe('warn');
  });
});
