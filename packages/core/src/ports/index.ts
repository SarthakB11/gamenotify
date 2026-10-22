import type {
  ChallengeId,
  DeliveryMode,
  EventId,
  EventKind,
  EventOf,
  InboxEntry,
  ItemId,
  ItemRarity,
  Notification,
  NotificationId,
  PlatformEvent,
  PlayerId,
  Result,
  UserPreferences,
} from '../domain/index.ts';

// ── Cross-cutting ──────────────────────────────────────────────────────────────

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export interface IdGenerator {
  eventId(): EventId;
  notificationId(): NotificationId;
}

export interface TimerHandle {
  cancel(): void;
}

/** Injected so tests can advance time deterministically. */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): TimerHandle;
}

export type LogFields = Record<string, unknown>;
export interface Logger {
  debug(fields: LogFields, msg?: string): void;
  info(fields: LogFields, msg?: string): void;
  warn(fields: LogFields, msg?: string): void;
  error(fields: LogFields, msg?: string): void;
  isDebugEnabled(): boolean;
}

export type Labels = Record<string, string>;
export interface Metrics {
  inc(name: string, labels?: Labels, by?: number): void;
  observe(name: string, value: number, labels?: Labels): void;
  gauge(name: string, value: number, labels?: Labels): void;
}

// ── Event ingestion (driving side) ─────────────────────────────────────────────

export type PublishResult = 'accepted' | 'rejected';
export type EventHandler<E extends PlatformEvent = PlatformEvent> = (event: E) => Promise<void> | void;
export type Unsubscribe = () => void;

export interface EventPublisher {
  /** Non-blocking. Returns 'rejected' when the bus is at capacity (back-pressure). */
  publish(event: PlatformEvent): PublishResult;
}

export interface EventSubscriber {
  subscribe<K extends EventKind>(kind: K, handler: EventHandler<EventOf<K>>): Unsubscribe;
  subscribeAll(handler: EventHandler): Unsubscribe;
}

export interface EventBus extends EventPublisher, EventSubscriber {
  readonly depth: number;
  /** Resolves once every queued event has been handled. */
  drain(): Promise<void>;
}

// ── Reference data (driven) ────────────────────────────────────────────────────

export interface PlayerProfile {
  readonly id: PlayerId;
  readonly displayName: string;
}

export interface PlayerDirectory {
  get(id: PlayerId): PlayerProfile | undefined;
  list(): readonly PlayerProfile[];
}

export interface ItemInfo {
  readonly id: ItemId;
  readonly name: string;
  readonly rarity: ItemRarity;
}

export interface ChallengeInfo {
  readonly id: ChallengeId;
  readonly name: string;
}

export interface ContentCatalog {
  item(id: ItemId): ItemInfo | undefined;
  challenge(id: ChallengeId): ChallengeInfo | undefined;
}

// ── State (driven) ─────────────────────────────────────────────────────────────

export interface PreferenceRepository {
  /** Returns defaults when the player has never saved preferences. */
  get(id: PlayerId): UserPreferences;
  /** Optimistic concurrency: fails if the stored version differs from `expectedVersion`. */
  save(prefs: UserPreferences, expectedVersion: number): Result<UserPreferences, 'VERSION_CONFLICT'>;
}

export type SinceResult =
  | { readonly kind: 'entries'; readonly entries: readonly InboxEntry[] }
  | { readonly kind: 'resync'; readonly oldestSeq: number };

export interface InboxRepository {
  /** Identifies this inbox instance; changes on restart so stale cursors trigger a resync. */
  readonly epoch: string;
  /** Appends and assigns the next per-player seq. */
  append(notification: Notification, mode: DeliveryMode): InboxEntry;
  /** Entries with seq > afterSeq (oldest first), or 'resync' if the cursor fell out of retention. */
  since(player: PlayerId, afterSeq: number, limit: number): SinceResult;
  /** Newest-first page of entries with seq < beforeSeq (or the newest when null). */
  page(player: PlayerId, beforeSeq: number | null, limit: number): readonly InboxEntry[];
  find(player: PlayerId, id: NotificationId): InboxEntry | undefined;
  /** Records the first successful push; returns the updated entry, or undefined if it is no longer retained. */
  markDelivered(player: PlayerId, seq: number, at: number): InboxEntry | undefined;
  markRead(player: PlayerId, id: NotificationId, at: number): boolean;
  markAllRead(player: PlayerId, upToSeq: number, at: number): number;
  unreadCount(player: PlayerId): number;
  lastSeq(player: PlayerId): number;
}

export interface IdempotencyStore {
  /** Returns true the first time a key is seen (and records it), false for duplicates. */
  firstSeen(key: string): boolean;
  /** Forgets a key recorded by `firstSeen`, so a retry of an event that failed mid-pipeline is not rejected. */
  release(key: string): void;
}

// ── Delivery (driven) ──────────────────────────────────────────────────────────

export type DeliveryResult = 'DELIVERED' | 'RECIPIENT_OFFLINE' | 'FAILED';

/**
 * The brief's "existing notification client or mechanism" that handles final delivery.
 * Implemented by the SSE gateway, the console demo sender and the test recorder.
 */
export interface NotificationSender {
  readonly name: string;
  /** True when the receiver renders the entry's SILENT flag itself (no alert), so SILENT entries are sent to it too. */
  readonly carriesSilent?: boolean;
  send(entry: InboxEntry): Promise<DeliveryResult> | DeliveryResult;
}

/** A delivery channel (in-app today; push / email tomorrow). */
export interface DeliveryChannel {
  readonly name: string;
  accepts(entry: InboxEntry, prefs: UserPreferences): boolean;
  send(entry: InboxEntry): Promise<DeliveryResult> | DeliveryResult;
}
