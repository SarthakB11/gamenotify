import type { DeliveryMode, InboxEntry, Notification, NotificationId, PlayerId } from '../../domain/index.ts';
import type { Clock, InboxRepository, SinceResult } from '../../ports/index.ts';

export interface InMemoryInboxOptions {
  /** Max retained entries per player (oldest evicted). */
  readonly capacity: number;
  /** Entries older than this are pruned lazily. */
  readonly ttlMs: number;
  readonly clock: Clock;
  /** Override for deterministic tests. */
  readonly epoch?: string;
}

const INITIAL_SLOTS = 8;

/** Per-player append-only log with contiguous seqs: slot lookup by seq is O(1) arithmetic. */
class PlayerLog {
  /** Grows on demand (doubling) up to `capacity`, so idle or quiet players cost a few slots, not the full cap. */
  ring: (InboxEntry | undefined)[];
  readonly capacity: number;
  head = 0;
  size = 0;
  /** seq of the oldest retained entry (== nextSeq when empty). */
  firstSeq = 1;
  nextSeq = 1;
  unread = 0;
  readonly byId = new Map<NotificationId, InboxEntry>();

  constructor(capacity: number) {
    this.capacity = capacity;
    this.ring = new Array<InboxEntry | undefined>(Math.min(capacity, INITIAL_SLOTS)).fill(undefined);
  }

  /** Make room for one more entry: grow the ring, or evict the oldest once at capacity. */
  makeRoom(): void {
    if (this.size < this.ring.length) return;
    if (this.ring.length >= this.capacity) {
      this.dropOldest();
      return;
    }
    const next = new Array<InboxEntry | undefined>(Math.min(this.capacity, this.ring.length * 2)).fill(undefined);
    for (let i = 0; i < this.size; i++) next[i] = this.ring[(this.head + i) % this.ring.length];
    this.ring = next;
    this.head = 0;
  }

  at(seq: number): InboxEntry | undefined {
    if (seq < this.firstSeq || seq >= this.nextSeq) return undefined;
    return this.ring[(this.head + (seq - this.firstSeq)) % this.ring.length];
  }

  dropOldest(): void {
    const e = this.ring[this.head];
    if (e !== undefined) {
      this.byId.delete(e.notification.id);
      if (e.readAt === null) this.unread--;
    }
    this.ring[this.head] = undefined;
    this.head = (this.head + 1) % this.ring.length;
    this.size--;
    this.firstSeq++;
  }
}

export class InMemoryInbox implements InboxRepository {
  readonly epoch: string;
  readonly #logs = new Map<PlayerId, PlayerLog>();
  readonly #capacity: number;
  readonly #ttl: number;
  readonly #clock: Clock;

  constructor(opts: InMemoryInboxOptions) {
    if (opts.capacity < 1) throw new RangeError('inbox capacity must be >= 1');
    this.#capacity = opts.capacity;
    this.#ttl = opts.ttlMs;
    this.#clock = opts.clock;
    this.epoch = opts.epoch ?? crypto.randomUUID().slice(0, 8);
  }

  append(notification: Notification, mode: DeliveryMode): InboxEntry {
    const log = this.#log(notification.recipientId, true) as PlayerLog;
    this.#prune(log);
    log.makeRoom();
    const entry: InboxEntry = { seq: log.nextSeq++, notification, mode, deliveredAt: null, readAt: null };
    log.ring[(log.head + log.size) % log.ring.length] = entry;
    log.size++;
    log.unread++;
    log.byId.set(notification.id, entry);
    return entry;
  }

  since(player: PlayerId, afterSeq: number, limit: number): SinceResult {
    const log = this.#log(player, false);
    if (log === undefined) return afterSeq === 0 ? { kind: 'entries', entries: [] } : { kind: 'resync', oldestSeq: 1 };
    this.#prune(log);
    if (afterSeq >= log.nextSeq) return { kind: 'resync', oldestSeq: log.firstSeq }; // cursor from the future
    if (afterSeq < log.firstSeq - 1) return { kind: 'resync', oldestSeq: log.firstSeq };
    const entries: InboxEntry[] = [];
    for (let seq = afterSeq + 1; seq < log.nextSeq && entries.length < limit; seq++) {
      const e = log.at(seq);
      if (e !== undefined) entries.push(e);
    }
    return { kind: 'entries', entries };
  }

  page(player: PlayerId, beforeSeq: number | null, limit: number): readonly InboxEntry[] {
    const log = this.#log(player, false);
    if (log === undefined) return [];
    this.#prune(log);
    const out: InboxEntry[] = [];
    const start = Math.min(beforeSeq === null ? log.nextSeq : beforeSeq, log.nextSeq) - 1;
    for (let seq = start; seq >= log.firstSeq && out.length < limit; seq--) {
      const e = log.at(seq);
      if (e !== undefined) out.push(e);
    }
    return out;
  }

  find(player: PlayerId, id: NotificationId): InboxEntry | undefined {
    return this.#log(player, false)?.byId.get(id);
  }

  markRead(player: PlayerId, id: NotificationId, at: number): boolean {
    const log = this.#log(player, false);
    const e = log?.byId.get(id);
    if (log === undefined || e === undefined) return false;
    if (e.readAt === null) {
      e.readAt = at;
      log.unread--;
    }
    return true;
  }

  markAllRead(player: PlayerId, upToSeq: number, at: number): number {
    const log = this.#log(player, false);
    if (log === undefined) return 0;
    let marked = 0;
    for (let seq = log.firstSeq; seq <= Math.min(upToSeq, log.nextSeq - 1); seq++) {
      const e = log.at(seq);
      if (e !== undefined && e.readAt === null) {
        e.readAt = at;
        marked++;
      }
    }
    log.unread -= marked;
    return marked;
  }

  unreadCount(player: PlayerId): number {
    const log = this.#log(player, false);
    if (log === undefined) return 0;
    this.#prune(log);
    return log.unread;
  }

  lastSeq(player: PlayerId): number {
    return (this.#log(player, false)?.nextSeq ?? 1) - 1;
  }

  #log(player: PlayerId, create: boolean): PlayerLog | undefined {
    let log = this.#logs.get(player);
    if (log === undefined && create) {
      log = new PlayerLog(this.#capacity);
      this.#logs.set(player, log);
    }
    return log;
  }

  /** Lazy TTL pruning from the head (entries are appended in time order). */
  #prune(log: PlayerLog): void {
    const cutoff = this.#clock.now() - this.#ttl;
    while (log.size > 0) {
      const oldest = log.ring[log.head];
      if (oldest === undefined || oldest.notification.createdAt >= cutoff) break;
      log.dropOldest();
    }
  }
}
