import type { EventId, PlayerId } from './ids.ts';
import type { JsonObject } from './json.ts';
import type { NotificationType } from './notification-type.ts';

/**
 * A cheap "would notify" record produced by resolvers. Filters (dedup, preferences, rate limit,
 * grouping) run on intents; only survivors are rendered into a Notification ("reject early, render late").
 */
export interface NotificationIntent {
  readonly recipientId: PlayerId;
  readonly type: NotificationType;
  readonly params: JsonObject;
  /** The other player involved (sender, follower, attacker...), if any. */
  readonly actorId?: PlayerId;
  readonly sourceEventId: EventId;
  readonly occurredAt: number;
  /** Set by resolvers for groupable types. */
  readonly groupKey?: string;
  /** Set by the grouping stage when it emits an aggregated intent. */
  readonly groupCount?: number;
  /** Set by the grouping stage: first few distinct actors of the group. */
  readonly actorIds?: readonly PlayerId[];
  /** Set by the grouping stage: number of distinct actors in the group. */
  readonly distinctActors?: number;
  /** Set by the grouping stage: the actor of the leading-edge event that was already delivered. */
  readonly leadingActorId?: PlayerId;
}
