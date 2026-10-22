import type { InboxEntry } from '../../domain/index.ts';
import type {
  Clock,
  DeliveryChannel,
  DeliveryResult,
  InboxRepository,
  Logger,
  Metrics,
  PreferenceRepository,
} from '../../ports/index.ts';

export interface DeliveryRouterDeps {
  readonly channels: readonly DeliveryChannel[];
  readonly prefs: PreferenceRepository;
  /** Receives `markDelivered` when a channel pushed the entry; entries themselves are immutable. */
  readonly inbox: InboxRepository;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: Logger;
}

/**
 * Strategy over channels. There is no retry: a failed or throwing channel is logged and counted, and the entry
 * stays in the inbox, so it is replayed when the player reconnects. RECIPIENT_OFFLINE is not a failure either.
 */
export class DeliveryRouter {
  readonly #d: DeliveryRouterDeps;

  constructor(deps: DeliveryRouterDeps) {
    this.#d = deps;
  }

  /**
   * Returns undefined when every channel completed synchronously (the common in-app case: no Promise
   * allocations on the hot path); otherwise a Promise that settles (never rejects) when async sends finish.
   */
  deliver(entry: InboxEntry): Promise<void> | undefined {
    const prefs = this.#d.prefs.get(entry.notification.recipientId);
    let pending: Promise<void>[] | undefined;
    for (const channel of this.#d.channels) {
      if (!channel.accepts(entry, prefs)) continue;
      const p = this.#trySync(channel, entry);
      if (p !== undefined) (pending ??= []).push(p);
    }
    if (pending === undefined) return undefined;
    return pending.length === 1 ? (pending[0] as Promise<void>) : Promise.all(pending).then(() => undefined);
  }

  #trySync(channel: DeliveryChannel, entry: InboxEntry): Promise<void> | undefined {
    let result: DeliveryResult | Promise<DeliveryResult>;
    try {
      result = channel.send(entry);
    } catch (e) {
      this.#failed(channel, entry, e);
      return undefined;
    }
    if (result instanceof Promise) {
      return result.then(
        (r) => this.#settle(channel, entry, r),
        (e: unknown) => this.#failed(channel, entry, e),
      );
    }
    this.#settle(channel, entry, result);
    return undefined;
  }

  #settle(channel: DeliveryChannel, entry: InboxEntry, result: DeliveryResult): void {
    if (result === 'FAILED') {
      this.#failed(channel, entry);
      return;
    }
    this.#d.metrics.inc('notifications_delivered_total', { channel: channel.name, result });
    if (result === 'DELIVERED') this.#d.inbox.markDelivered(entry.notification.recipientId, entry.seq, this.#d.clock.now());
  }

  #failed(channel: DeliveryChannel, entry: InboxEntry, error?: unknown): void {
    this.#d.metrics.inc('notifications_delivered_total', { channel: channel.name, result: 'FAILED' });
    this.#d.logger.warn(
      {
        channel: channel.name,
        playerId: entry.notification.recipientId,
        seq: entry.seq,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      },
      'delivery failed; the entry stays in the inbox for replay',
    );
  }
}
