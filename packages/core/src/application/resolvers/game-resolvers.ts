import {
  type ChallengeCompleted,
  type ItemAcquired,
  type ItemRarity,
  NotificationType,
  type PlayerLeveledUp,
  type PvpAttacked,
  type PvpDefeated,
  SuppressionReason,
} from '../../domain/index.ts';
import type { ContentCatalog, Metrics } from '../../ports/index.ts';
import { groupKeyFor, type IntentResolver, type Resolution } from './resolver.ts';

export class LevelUpResolver implements IntentResolver<'game.player_leveled_up'> {
  readonly kind = 'game.player_leveled_up' as const;
  resolve(e: PlayerLeveledUp): readonly Resolution[] {
    return [
      {
        recipientId: e.playerId,
        type: NotificationType.LEVEL_UP,
        params: { level: e.newLevel },
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
      },
    ];
  }
}

/** Only "rare or valuable" items are notification-worthy (product rule, not a user preference). */
export class ItemAcquiredResolver implements IntentResolver<'game.item_acquired'> {
  readonly kind = 'game.item_acquired' as const;
  readonly #catalog: ContentCatalog;
  readonly #minRarity: ItemRarity;
  readonly #metrics: Metrics;

  constructor(catalog: ContentCatalog, minRarity: ItemRarity, metrics: Metrics) {
    this.#catalog = catalog;
    this.#minRarity = minRarity;
    this.#metrics = metrics;
  }

  resolve(e: ItemAcquired): readonly Resolution[] {
    const item = this.#catalog.item(e.itemId);
    if (item === undefined) {
      // Fail open: an uncatalogued item still notifies (with a humanised name); flag it for ops.
      this.#metrics.inc('catalog_miss_total', { kind: 'item' });
    } else if (item.rarity < this.#minRarity) {
      return [
        {
          skip: SuppressionReason.BELOW_RARITY_THRESHOLD,
          recipientId: e.playerId,
          type: NotificationType.ITEM_ACQUIRED,
        },
      ];
    }
    return [
      {
        recipientId: e.playerId,
        type: NotificationType.ITEM_ACQUIRED,
        params: { itemId: e.itemId },
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
      },
    ];
  }
}

export class ChallengeCompletedResolver implements IntentResolver<'game.challenge_completed'> {
  readonly kind = 'game.challenge_completed' as const;
  resolve(e: ChallengeCompleted): readonly Resolution[] {
    return [
      {
        recipientId: e.playerId,
        type: NotificationType.CHALLENGE_COMPLETED,
        params: { challengeId: e.challengeId },
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
      },
    ];
  }
}

export class PvpAttackedResolver implements IntentResolver<'game.pvp_attacked'> {
  readonly kind = 'game.pvp_attacked' as const;
  resolve(e: PvpAttacked): readonly Resolution[] {
    if (e.attackerId === e.victimId) {
      return [{ skip: SuppressionReason.SELF_ACTION, recipientId: e.victimId, type: NotificationType.PVP_ATTACKED }];
    }
    return [
      {
        recipientId: e.victimId,
        type: NotificationType.PVP_ATTACKED,
        params: {},
        actorId: e.attackerId,
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
        groupKey: groupKeyFor(NotificationType.PVP_ATTACKED, e.victimId),
      },
    ];
  }
}

/** One event fans out to both participants with different messages. */
export class PvpDefeatedResolver implements IntentResolver<'game.pvp_defeated'> {
  readonly kind = 'game.pvp_defeated' as const;
  resolve(e: PvpDefeated): readonly Resolution[] {
    if (e.winnerId === e.loserId) {
      return [{ skip: SuppressionReason.SELF_ACTION, recipientId: e.loserId, type: NotificationType.PVP_DEFEATED }];
    }
    return [
      {
        recipientId: e.loserId,
        type: NotificationType.PVP_DEFEATED,
        params: {},
        actorId: e.winnerId,
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
      },
      {
        recipientId: e.winnerId,
        type: NotificationType.PVP_VICTORY,
        params: {},
        actorId: e.loserId,
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
      },
    ];
  }
}
