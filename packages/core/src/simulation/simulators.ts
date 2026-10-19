import { ChallengeId, ItemId, type NewPlatformEvent, type PlatformEvent, PlayerId } from '../domain/index.ts';
import type { Clock, EventPublisher, IdGenerator, PublishResult } from '../ports/index.ts';

abstract class EventSource {
  readonly #bus: EventPublisher;
  readonly #ids: IdGenerator;
  readonly #clock: Clock;

  constructor(bus: EventPublisher, ids: IdGenerator, clock: Clock) {
    this.#bus = bus;
    this.#ids = ids;
    this.#clock = clock;
  }

  protected emit(event: NewPlatformEvent): PublishResult {
    return this.#bus.publish({ ...event, eventId: this.#ids.eventId(), occurredAt: this.#clock.now() } as PlatformEvent);
  }
}

/**
 * Simulated game engine. Method names and argument order follow the brief exactly, e.g.
 * `gameEngine.playerLeveledUp(1, 15)` — "User 1 leveled up to 15".
 */
export class GameEngine extends EventSource {
  playerLeveledUp(playerId: number, newLevel: number): PublishResult {
    if (!Number.isInteger(newLevel) || newLevel < 1) throw new RangeError(`Invalid level ${newLevel}`);
    return this.emit({ kind: 'game.player_leveled_up', playerId: PlayerId(playerId), newLevel });
  }

  itemAcquired(playerId: number, itemId: string): PublishResult {
    return this.emit({ kind: 'game.item_acquired', playerId: PlayerId(playerId), itemId: ItemId(itemId) });
  }

  challengeCompleted(playerId: number, challengeId: string): PublishResult {
    return this.emit({ kind: 'game.challenge_completed', playerId: PlayerId(playerId), challengeId: ChallengeId(challengeId) });
  }

  /** PvP: `attackerId` attacked `victimId`. */
  playerAttacked(attackerId: number, victimId: number): PublishResult {
    return this.emit({ kind: 'game.pvp_attacked', attackerId: PlayerId(attackerId), victimId: PlayerId(victimId) });
  }

  /** PvP: `winnerId` defeated `loserId`. */
  playerDefeated(winnerId: number, loserId: number): PublishResult {
    return this.emit({ kind: 'game.pvp_defeated', winnerId: PlayerId(winnerId), loserId: PlayerId(loserId) });
  }
}

/** Simulated social system. `friendRequestSent(3, 1)` — "User 3 sent a friend request to user 1". */
export class SocialSystem extends EventSource {
  friendRequestSent(senderId: number, recipientId: number): PublishResult {
    return this.emit({ kind: 'social.friend_request_sent', senderId: PlayerId(senderId), recipientId: PlayerId(recipientId) });
  }

  /** `friendRequestAccepted(1, 3)` — "User 1 accepted friend request from 3". */
  friendRequestAccepted(accepterId: number, requesterId: number): PublishResult {
    return this.emit({
      kind: 'social.friend_request_accepted',
      accepterId: PlayerId(accepterId),
      requesterId: PlayerId(requesterId),
    });
  }

  /** `followerId` started following `followeeId`. */
  playerFollowed(followerId: number, followeeId: number): PublishResult {
    return this.emit({ kind: 'social.player_followed', followerId: PlayerId(followerId), followeeId: PlayerId(followeeId) });
  }
}
