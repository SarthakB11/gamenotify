import type { ChallengeId, ItemId, PlayerId } from '../../domain/index.ts';
import type { ChallengeInfo, ContentCatalog, ItemInfo, PlayerDirectory, PlayerProfile } from '../../ports/index.ts';

export class InMemoryPlayerDirectory implements PlayerDirectory {
  readonly #players: ReadonlyMap<PlayerId, PlayerProfile>;
  constructor(players: readonly PlayerProfile[]) {
    this.#players = new Map(players.map((p) => [p.id, p]));
  }
  get(id: PlayerId): PlayerProfile | undefined {
    return this.#players.get(id);
  }
  list(): readonly PlayerProfile[] {
    return [...this.#players.values()];
  }
}

export class InMemoryContentCatalog implements ContentCatalog {
  readonly #items: ReadonlyMap<ItemId, ItemInfo>;
  readonly #challenges: ReadonlyMap<ChallengeId, ChallengeInfo>;
  constructor(items: readonly ItemInfo[], challenges: readonly ChallengeInfo[]) {
    this.#items = new Map(items.map((i) => [i.id, i]));
    this.#challenges = new Map(challenges.map((c) => [c.id, c]));
  }
  item(id: ItemId): ItemInfo | undefined {
    return this.#items.get(id);
  }
  challenge(id: ChallengeId): ChallengeInfo | undefined {
    return this.#challenges.get(id);
  }
}
