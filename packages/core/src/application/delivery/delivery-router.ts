import type { InboxEntry } from '../../domain/index.ts';
import type {
  Clock,
  DeadLetterQueue,
  DeliveryChannel,
  DeliveryResult,
  InboxRepository,
  Logger,
  Metrics,
  PreferenceRepository,
} from '../../ports/index.ts';
import type { RetryPolicy } from './retry-policy.ts';

export interface DeliveryRouterDeps {
  readonly channels: readonly DeliveryChannel[];
  readonly retry: RetryPolicy;
  readonly dlq: DeadLetterQueue;
  readonly prefs: PreferenceRepository;
  /** Receives `markDelivered` when a channel pushed the entry; entries themselves are immutable. */
  readonly inbox: InboxRepository;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Strategy over channels + retry with jittered backoff + dead-lettering.
 * RECIPIENT_OFFLINE is not a failure: the entry is already in the inbox and will be replayed on reconnect.
 */
export class DeliveryRouter {
  readonly #d: DeliveryRouterDeps;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(deps: DeliveryRouterDeps) {
    this.#d = deps;
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Returns undefined when every channel completed synchronously (the common in-app case: no Promise
   * allocations on the hot path); otherwise a Promise that settles when retries/async sends finish.
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
    } catch {
      return this.#withRetry(channel, entry, 1, 'FAILED');
    }
    if (result instanceof Promise) return this.#withRetry(channel, entry, 1, result);
    if (result === 'FAILED') return this.#withRetry(channel, entry, 1, result);
    this.#d.metrics.inc('notifications_delivered_total', { channel: channel.name, result });
    this.#markDelivered(entry, result);
    return undefined;
  }

  #markDelivered(entry: InboxEntry, result: DeliveryResult): void {
    if (result === 'DELIVERED') this.#d.inbox.markDelivered(entry.notification.recipientId, entry.seq, this.#d.clock.now());
  }

  async #withRetry(
    channel: DeliveryChannel,
    entry: InboxEntry,
    firstAttempt: number,
    first: DeliveryResult | Promise<DeliveryResult>,
  ): Promise<void> {
    for (let attempt = firstAttempt; ; attempt++) {
      let result: DeliveryResult;
      let error = '';
      try {
        result = attempt === firstAttempt ? await first : await channel.send(entry);
      } catch (e) {
        result = 'FAILED';
        error = e instanceof Error ? e.message : String(e);
      }
      this.#d.metrics.inc('notifications_delivered_total', { channel: channel.name, result });
      if (result !== 'FAILED') {
        this.#markDelivered(entry, result);
        return;
      }
      if (attempt >= this.#d.retry.maxAttempts) {
        this.#d.dlq.put({ entry, channel: channel.name, attempts: attempt, at: this.#d.clock.now(), error });
        this.#d.metrics.gauge('dlq_size', this.#d.dlq.size);
        this.#d.logger.error(
          { notificationId: entry.notification.id, channel: channel.name, attempts: attempt, error },
          'delivery failed; dead-lettered',
        );
        return;
      }
      await this.#sleep(this.#d.retry.delay(attempt));
    }
  }
}
