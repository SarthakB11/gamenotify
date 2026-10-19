import type { InboxEntry, NotificationId, PlayerId } from '../../domain/index.ts';
import type { Clock, InboxRepository } from '../../ports/index.ts';

export interface InboxPage {
  readonly epoch: string;
  readonly entries: readonly InboxEntry[];
  /** Pass as `before` to get the next (older) page; null when exhausted. */
  readonly nextBefore: number | null;
  readonly unread: number;
}

export class InboxService {
  readonly #inbox: InboxRepository;
  readonly #clock: Clock;

  constructor(inbox: InboxRepository, clock: Clock) {
    this.#inbox = inbox;
    this.#clock = clock;
  }

  page(player: PlayerId, before: number | null, limit: number): InboxPage {
    const entries = this.#inbox.page(player, before, limit);
    const last = entries.at(-1);
    return {
      epoch: this.#inbox.epoch,
      entries,
      nextBefore: entries.length === limit && last !== undefined && last.seq > 1 ? last.seq : null,
      unread: this.#inbox.unreadCount(player),
    };
  }

  markRead(player: PlayerId, id: NotificationId): boolean {
    return this.#inbox.markRead(player, id, this.#clock.now());
  }

  markAllRead(player: PlayerId, upToSeq?: number): number {
    return this.#inbox.markAllRead(player, upToSeq ?? this.#inbox.lastSeq(player), this.#clock.now());
  }

  unread(player: PlayerId): number {
    return this.#inbox.unreadCount(player);
  }
}
