import { describe, expect, it } from 'vitest';
import {
  EN_CATALOG,
  EventId,
  humanizeId,
  InMemoryContentCatalog,
  InMemoryPlayerDirectory,
  NotificationFactory,
  type NotificationIntent,
  NotificationRenderer,
  PlayerId,
  SEED,
  sanitizeName,
} from '../src/index.ts';
import { FakeClock, seqIds } from '../src/testing/index.ts';

const directory = new InMemoryPlayerDirectory([
  ...SEED.players,
  { id: PlayerId(99), displayName: '  Evil\u0000‮Name-that-is-way-too-long-for-a-toast ' },
]);
const catalog = new InMemoryContentCatalog(SEED.items, SEED.challenges);
const renderer = new NotificationRenderer(EN_CATALOG, directory, catalog, new NotificationFactory(seqIds(), new FakeClock()));

const intent = (p: Partial<NotificationIntent> & Pick<NotificationIntent, 'type'>): NotificationIntent => ({
  recipientId: PlayerId(1),
  params: {},
  sourceEventId: EventId('e'),
  occurredAt: 0,
  ...p,
});
const msg = (p: Partial<NotificationIntent> & Pick<NotificationIntent, 'type'>) => renderer.render(intent(p)).message;

describe('message catalog (exact strings)', () => {
  it('matches the brief examples', () => {
    expect(msg({ type: 'LEVEL_UP', params: { level: 15 } })).toBe("Congratulations! You've reached level 15!");
    expect(msg({ type: 'ITEM_ACQUIRED', params: { itemId: 'SwordOfAzeroth' } })).toBe(
      "You've acquired the legendary Sword of Azeroth!",
    );
    expect(msg({ type: 'FRIEND_REQUEST', actorId: PlayerId(3) })).toBe("Player 'Kael' has sent you a friend request.");
  });

  it('renders every other type', () => {
    expect(msg({ type: 'ITEM_ACQUIRED', params: { itemId: 'DragonboneBow' } })).toBe("You've acquired the epic Dragonbone Bow!");
    expect(msg({ type: 'ITEM_ACQUIRED', params: { itemId: 'GoldenHeartOfTheSea' } })).toBe(
      "You've acquired the Golden Heart of the Sea!",
    );
    expect(msg({ type: 'CHALLENGE_COMPLETED', params: { challengeId: 'DragonsLair' } })).toBe(
      "Challenge complete! You've conquered 'Dragon's Lair'.",
    );
    expect(msg({ type: 'CHALLENGE_COMPLETED', params: { challengeId: 'speed_run' } })).toBe(
      "Challenge complete! You've conquered 'Speed Run'.",
    );
    expect(msg({ type: 'PVP_ATTACKED', actorId: PlayerId(5) })).toBe("You're under attack by Player 'Zed'!");
    expect(msg({ type: 'PVP_DEFEATED', actorId: PlayerId(5) })).toBe("You were defeated by Player 'Zed'.");
    expect(msg({ type: 'PVP_VICTORY', actorId: PlayerId(4) })).toBe("You defeated Player 'Mira'!");
    expect(msg({ type: 'FRIEND_ACCEPTED', actorId: PlayerId(1) })).toBe("Player 'Aria' accepted your friend request.");
    expect(msg({ type: 'NEW_FOLLOWER', actorId: PlayerId(3) })).toBe("Player 'Kael' started following you.");
  });

  it('renders grouped forms', () => {
    expect(msg({ type: 'NEW_FOLLOWER', actorIds: [PlayerId(3), PlayerId(4)], distinctActors: 2, groupCount: 2 })).toBe(
      "Player 'Kael' and 1 other started following you.",
    );
    expect(msg({ type: 'NEW_FOLLOWER', actorIds: [PlayerId(3)], distinctActors: 4, groupCount: 4 })).toBe(
      "Player 'Kael' and 3 others started following you.",
    );
    expect(msg({ type: 'PVP_ATTACKED', actorIds: [PlayerId(5)], distinctActors: 1, groupCount: 3, leadingActorId: PlayerId(5) })).toBe(
      "Player 'Zed' attacked you 3 more times!",
    );
    // A different attacker than the delivered first notification must not get "more".
    expect(msg({ type: 'PVP_ATTACKED', actorIds: [PlayerId(3)], distinctActors: 1, groupCount: 3, leadingActorId: PlayerId(5) })).toBe(
      "Player 'Kael' attacked you 3 times!",
    );
    expect(msg({ type: 'PVP_ATTACKED', actorIds: [PlayerId(5), PlayerId(6)], distinctActors: 3, groupCount: 3 })).toBe(
      "You're under attack by Player 'Zed' and 2 others!",
    );
    expect(
      renderer.render(intent({ type: 'NEW_FOLLOWER', actorIds: [PlayerId(3)], distinctActors: 2, groupCount: 2 })).title,
    ).toBe('New Followers');
  });

  it('handles unknown and hostile names', () => {
    expect(msg({ type: 'FRIEND_REQUEST', actorId: PlayerId(404) })).toBe("Player '#404' has sent you a friend request.");
    const m = msg({ type: 'FRIEND_REQUEST', actorId: PlayerId(99) });
    expect(m).not.toMatch(/[\u0000‮]/);
    expect(m).toContain('…');
    expect(msg({ type: 'PVP_DEFEATED' })).toBe('You were defeated by Someone.');
  });

  it('builds structured data for clients', () => {
    const n = renderer.render(intent({ type: 'ITEM_ACQUIRED', params: { itemId: 'SwordOfAzeroth' } }));
    expect(n.data).toEqual({ itemId: 'SwordOfAzeroth', rarity: 4 });
    const g = renderer.render(
      intent({ type: 'NEW_FOLLOWER', actorIds: [PlayerId(3)], distinctActors: 2, groupCount: 2, groupKey: 'k' }),
    );
    expect(g.data).toEqual({ actorIds: [3], distinctActors: 2 });
    expect(g.groupCount).toBe(2);
    expect(g.groupKey).toBe('k');
    expect(g.title).toBe('New Followers');
  });
});

describe('text helpers', () => {
  it('humanizes ids', () => {
    expect(humanizeId('SwordOfAzeroth')).toBe('Sword of Azeroth');
    expect(humanizeId('XPBoostPotion')).toBe('Xp Boost Potion');
    expect(humanizeId('dragon-lair')).toBe('Dragon Lair');
  });
  it('sanitizes names', () => {
    expect(sanitizeName('  Bob\u0007 ')).toBe('Bob');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(32);
  });
});
