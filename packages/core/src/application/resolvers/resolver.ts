import type {
  EventKind,
  EventOf,
  NotificationIntent,
  NotificationType,
  PlayerId,
  SuppressionReason,
} from '../../domain/index.ts';

/** A resolver decided not to notify someone, and says why (for metrics / demo output). */
export interface ResolverSkip {
  readonly skip: SuppressionReason;
  readonly recipientId: PlayerId;
  readonly type: NotificationType;
}

export type Resolution = NotificationIntent | ResolverSkip;
export const isSkip = (r: Resolution): r is ResolverSkip => 'skip' in r;

/**
 * Strategy: maps one kind of platform event to the notification intents it produces (0..n recipients).
 * Adding a new event type = adding one resolver and registering it; nothing else changes.
 */
export interface IntentResolver<K extends EventKind = EventKind> {
  readonly kind: K;
  resolve(event: EventOf<K>): readonly Resolution[];
}

export const groupKeyFor = (type: NotificationType, recipientId: PlayerId): string => `${type}:${recipientId}`;
