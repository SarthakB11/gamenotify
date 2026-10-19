import { ChallengeId, ItemId, ItemRarity, PlayerId } from '../../domain/index.ts';
import type { ChallengeInfo, ItemInfo, PlayerProfile } from '../../ports/index.ts';

/** Demo reference data. Player ids match the brief's examples (1, 2, 3 ...). */
export const SEED: {
  readonly players: readonly PlayerProfile[];
  readonly items: readonly ItemInfo[];
  readonly challenges: readonly ChallengeInfo[];
} = Object.freeze({
  players: [
    { id: PlayerId(1), displayName: 'Aria' },
    { id: PlayerId(2), displayName: 'Bram' },
    { id: PlayerId(3), displayName: 'Kael' },
    { id: PlayerId(4), displayName: 'Mira' },
    { id: PlayerId(5), displayName: 'Zed' },
    { id: PlayerId(6), displayName: 'Nyx' },
  ],
  items: [
    { id: ItemId('SwordOfAzeroth'), name: 'Sword of Azeroth', rarity: ItemRarity.LEGENDARY },
    { id: ItemId('DragonboneBow'), name: 'Dragonbone Bow', rarity: ItemRarity.EPIC },
    { id: ItemId('MoonstoneAmulet'), name: 'Moonstone Amulet', rarity: ItemRarity.RARE },
    { id: ItemId('IronShield'), name: 'Iron Shield', rarity: ItemRarity.UNCOMMON },
    { id: ItemId('RustyDagger'), name: 'Rusty Dagger', rarity: ItemRarity.COMMON },
  ],
  challenges: [
    { id: ChallengeId('DragonsLair'), name: "Dragon's Lair" },
    { id: ChallengeId('HundredWins'), name: 'Centurion' },
  ],
});
