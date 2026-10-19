import type { ChallengeId, EventId, ItemId, PlayerId } from './ids.ts';

interface EventBase {
  /** Producer-assigned unique id; doubles as the idempotency key. */
  readonly eventId: EventId;
  /** Epoch milliseconds. */
  readonly occurredAt: number;
}

export type PlayerLeveledUp = EventBase & {
  readonly kind: 'game.player_leveled_up';
  readonly playerId: PlayerId;
  readonly newLevel: number;
};
export type ItemAcquired = EventBase & {
  readonly kind: 'game.item_acquired';
  readonly playerId: PlayerId;
  readonly itemId: ItemId;
};
export type ChallengeCompleted = EventBase & {
  readonly kind: 'game.challenge_completed';
  readonly playerId: PlayerId;
  readonly challengeId: ChallengeId;
};
export type PvpAttacked = EventBase & {
  readonly kind: 'game.pvp_attacked';
  readonly attackerId: PlayerId;
  readonly victimId: PlayerId;
};
export type PvpDefeated = EventBase & {
  readonly kind: 'game.pvp_defeated';
  readonly winnerId: PlayerId;
  readonly loserId: PlayerId;
};
export type FriendRequestSent = EventBase & {
  readonly kind: 'social.friend_request_sent';
  readonly senderId: PlayerId;
  readonly recipientId: PlayerId;
};
export type FriendRequestAccepted = EventBase & {
  readonly kind: 'social.friend_request_accepted';
  readonly accepterId: PlayerId;
  readonly requesterId: PlayerId;
};
export type PlayerFollowed = EventBase & {
  readonly kind: 'social.player_followed';
  readonly followerId: PlayerId;
  readonly followeeId: PlayerId;
};

/** Every event the platform can emit, discriminated on `kind`. */
export type PlatformEvent =
  | PlayerLeveledUp
  | ItemAcquired
  | ChallengeCompleted
  | PvpAttacked
  | PvpDefeated
  | FriendRequestSent
  | FriendRequestAccepted
  | PlayerFollowed;

export type EventKind = PlatformEvent['kind'];
export type EventOf<K extends EventKind> = Extract<PlatformEvent, { kind: K }>;

/** Distributive Omit so each union member keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewPlatformEvent = DistributiveOmit<PlatformEvent, 'eventId' | 'occurredAt'>;

export const ALL_EVENT_KINDS: readonly EventKind[] = Object.freeze([
  'game.player_leveled_up',
  'game.item_acquired',
  'game.challenge_completed',
  'game.pvp_attacked',
  'game.pvp_defeated',
  'social.friend_request_sent',
  'social.friend_request_accepted',
  'social.player_followed',
] satisfies EventKind[]);
