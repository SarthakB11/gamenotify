import {
  type FriendRequestAccepted,
  type FriendRequestSent,
  NotificationType,
  type PlayerFollowed,
  SuppressionReason,
} from '../../domain/index.ts';
import { groupKeyFor, type IntentResolver, type Resolution } from './resolver.ts';

export class FriendRequestResolver implements IntentResolver<'social.friend_request_sent'> {
  readonly kind = 'social.friend_request_sent' as const;
  resolve(e: FriendRequestSent): readonly Resolution[] {
    if (e.senderId === e.recipientId) {
      return [{ skip: SuppressionReason.SELF_ACTION, recipientId: e.recipientId, type: NotificationType.FRIEND_REQUEST }];
    }
    return [
      {
        recipientId: e.recipientId,
        type: NotificationType.FRIEND_REQUEST,
        params: {},
        actorId: e.senderId,
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
      },
    ];
  }
}

/** friendRequestAccepted(1, 3): player 1 accepted 3's request, so player 3 (the requester) is told. */
export class FriendAcceptedResolver implements IntentResolver<'social.friend_request_accepted'> {
  readonly kind = 'social.friend_request_accepted' as const;
  resolve(e: FriendRequestAccepted): readonly Resolution[] {
    if (e.accepterId === e.requesterId) {
      return [{ skip: SuppressionReason.SELF_ACTION, recipientId: e.requesterId, type: NotificationType.FRIEND_ACCEPTED }];
    }
    return [
      {
        recipientId: e.requesterId,
        type: NotificationType.FRIEND_ACCEPTED,
        params: {},
        actorId: e.accepterId,
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
      },
    ];
  }
}

export class NewFollowerResolver implements IntentResolver<'social.player_followed'> {
  readonly kind = 'social.player_followed' as const;
  resolve(e: PlayerFollowed): readonly Resolution[] {
    if (e.followerId === e.followeeId) {
      return [{ skip: SuppressionReason.SELF_ACTION, recipientId: e.followeeId, type: NotificationType.NEW_FOLLOWER }];
    }
    return [
      {
        recipientId: e.followeeId,
        type: NotificationType.NEW_FOLLOWER,
        params: {},
        actorId: e.followerId,
        sourceEventId: e.eventId,
        occurredAt: e.occurredAt,
        groupKey: groupKeyFor(NotificationType.NEW_FOLLOWER, e.followeeId),
      },
    ];
  }
}
