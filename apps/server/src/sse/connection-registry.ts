import type { DeliveryResult, InboxEntry, Metrics, NotificationSender, PlayerId } from '@gamenotify/core';
import { HEARTBEAT_FRAME, notificationFrame } from './frame.ts';
import type { SseConnection } from './sse-connection.ts';

/** Player → live connections (multi-device). Also answers presence queries. */
export class ConnectionRegistry {
  readonly #byPlayer = new Map<PlayerId, Set<SseConnection>>();
  readonly #maxPerPlayer: number;
  readonly #metrics: Metrics;
  #count = 0;
  #heartbeat: NodeJS.Timeout | null = null;

  constructor(maxPerPlayer: number, metrics: Metrics) {
    this.#maxPerPlayer = maxPerPlayer;
    this.#metrics = metrics;
  }

  get size(): number {
    return this.#count;
  }

  add(conn: SseConnection): void {
    let set = this.#byPlayer.get(conn.playerId);
    if (!set) {
      set = new Set();
      this.#byPlayer.set(conn.playerId, set);
    }
    if (set.size >= this.#maxPerPlayer) {
      const oldest = set.values().next().value;
      oldest?.close('too_many_connections');
    }
    set.add(conn);
    this.#count++;
    this.#metrics.gauge('sse_connections', this.#count);
  }

  remove(conn: SseConnection): void {
    const set = this.#byPlayer.get(conn.playerId);
    if (set?.delete(conn)) {
      this.#count--;
      if (set.size === 0) this.#byPlayer.delete(conn.playerId);
      this.#metrics.gauge('sse_connections', this.#count);
    }
  }

  get(player: PlayerId): ReadonlySet<SseConnection> | undefined {
    return this.#byPlayer.get(player);
  }

  isOnline(player: PlayerId): boolean {
    return this.#byPlayer.has(player);
  }

  /** One timer for the whole process; only idle connections get a comment frame. */
  startHeartbeat(intervalMs: number, now: () => number = Date.now): void {
    this.stopHeartbeat();
    this.#heartbeat = setInterval(() => {
      const t = now();
      for (const set of this.#byPlayer.values()) {
        for (const c of set) if (t - c.lastWriteAt >= intervalMs) c.write(HEARTBEAT_FRAME);
      }
    }, intervalMs);
    this.#heartbeat.unref();
  }

  stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  closeAll(): void {
    for (const set of [...this.#byPlayer.values()]) for (const c of [...set]) c.close();
  }
}

/** The NotificationSender port implemented over SSE: serialize once, write to every device of the player. */
export class SseNotificationSender implements NotificationSender {
  readonly name = 'sse';
  readonly #registry: ConnectionRegistry;
  readonly #epoch: string;
  readonly #now: () => number;

  constructor(registry: ConnectionRegistry, epoch: string, now: () => number = Date.now) {
    this.#registry = registry;
    this.#epoch = epoch;
    this.#now = now;
  }

  send(entry: InboxEntry): DeliveryResult {
    const conns = this.#registry.get(entry.notification.recipientId);
    if (conns === undefined || conns.size === 0) return 'RECIPIENT_OFFLINE';
    const frame = notificationFrame(this.#epoch, entry);
    for (const c of conns) c.deliver(entry.seq, frame);
    entry.deliveredAt = this.#now();
    return 'DELIVERED';
  }
}
