import {
  DeliveryMode,
  type InboxEntry,
  type NotificationIntent,
  type NotificationType,
  type PlatformEvent,
  type PlayerId,
  type SuppressionReason,
} from '../domain/index.ts';
import type {
  Clock,
  EventSubscriber,
  InboxRepository,
  Logger,
  Metrics,
  PreferenceRepository,
  Unsubscribe,
} from '../ports/index.ts';
import type { DeliveryRouter } from './delivery/delivery-router.ts';
import type { GroupingStage } from './pipeline/grouping-stage.ts';
import { type PipelineStage, runStages, type StageContext } from './pipeline/stage.ts';
import type { NotificationRenderer } from './render/renderer.ts';
import { isSkip } from './resolvers/resolver.ts';
import type { ResolverRegistry } from './resolvers/resolver-registry.ts';

export interface SuppressedInfo {
  readonly eventId: string;
  readonly recipientId: PlayerId;
  readonly type: NotificationType;
  readonly reason: SuppressionReason;
}

/** Optional hooks (demo output, audit, tests). Must be cheap and must not throw. */
export interface DispatchObserver {
  onCreated?(entry: InboxEntry): void;
  onSuppressed?(info: SuppressedInfo): void;
}

export interface DispatcherDeps {
  readonly resolvers: ResolverRegistry;
  /** Run on every intent before grouping (idempotency, preferences). Held events stop here. */
  readonly stages: readonly PipelineStage[];
  /** Run only on what is actually emitted, after grouping: the leading-edge intent and each digest (rate limit). */
  readonly emissionStages: readonly PipelineStage[];
  /** Re-run when a digest is emitted, so preference changes made during the window apply to it. */
  readonly digestStages: readonly PipelineStage[];
  readonly grouping: GroupingStage;
  readonly renderer: NotificationRenderer;
  readonly inbox: InboxRepository;
  readonly delivery: DeliveryRouter;
  readonly prefs: PreferenceRepository;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: Logger;
}

/**
 * Orchestrates the brief's flow — receive event → determine type → check preferences → create → send —
 * with filters applied to cheap intents before the Notification is rendered:
 *
 *   event → resolvers → [idempotency → preferences] → grouping → [rate-limit] → render → inbox → delivery
 */
export class NotificationDispatcher {
  readonly #d: DispatcherDeps;
  readonly #observers: DispatchObserver[] = [];
  readonly #inflight = new Set<Promise<void>>();

  constructor(deps: DispatcherDeps) {
    this.#d = deps;
    deps.grouping.onFlush((intent) => this.#emitDigest(intent));
  }

  observe(observer: DispatchObserver): Unsubscribe {
    this.#observers.push(observer);
    return () => {
      const i = this.#observers.indexOf(observer);
      if (i >= 0) this.#observers.splice(i, 1);
    };
  }

  start(bus: EventSubscriber): Unsubscribe {
    return bus.subscribeAll((event) => this.handle(event));
  }

  /** Synchronous by design: delivery is started but never awaited here (see LLD §5.2). */
  handle(event: PlatformEvent): void {
    const t0 = performance.now();
    const d = this.#d;
    d.metrics.inc('events_received_total', { kind: event.kind });

    for (const r of d.resolvers.resolve(event)) {
      if (isSkip(r)) {
        this.#suppressed(event.eventId, r.recipientId, r.type, r.skip);
        continue;
      }
      const ctx: StageContext = {
        intent: r,
        prefs: d.prefs.get(r.recipientId),
        mode: DeliveryMode.LIVE,
        now: d.clock.now(),
      };
      // Set once the inbox holds the notification: from then on the dedup key must stay recorded.
      let stored = false;
      // Group key opened by this leading-edge event; cancelled if the event then fails before storing.
      let openedGroup: string | undefined;
      try {
        const verdict = runStages(d.stages, ctx);
        if (verdict.kind === 'suppress') {
          this.#suppressed(event.eventId, r.recipientId, r.type, verdict.reason);
          continue;
        }
        if (d.grouping.offer(ctx) === 'held') {
          this.#suppressed(event.eventId, r.recipientId, r.type, 'GROUPED');
          continue;
        }
        openedGroup = r.groupKey;
        // Only what is emitted (leading edge, ungrouped) spends rate-limit tokens; held events never do.
        runStages(d.emissionStages, ctx);
        const entry = this.#store(r, ctx.mode);
        stored = true;
        this.#announce(entry, ctx.mode);
      } catch (error) {
        // Mark-then-rollback: release the dedup key so the producer's retry is processed, and keep
        // going so one recipient's failure (e.g. a PvP fan-out) does not drop the others.
        if (!stored) for (const stage of d.stages) stage.rollback?.(ctx);
        if (!stored && openedGroup !== undefined) d.grouping.cancel(openedGroup);
        d.metrics.inc('dispatch_errors_total', { kind: event.kind });
        d.logger.error({ err: error, eventId: event.eventId, playerId: r.recipientId }, 'dispatch failed; will accept a retry');
      }
    }
    d.metrics.observe('dispatch_latency_seconds', (performance.now() - t0) / 1000);
  }

  /** Resolves when no delivery attempt is in flight (graceful shutdown, tests). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  /**
   * Trailing digest: preferences may have changed since the burst began, so its mode is decided here, at emission
   * (disabled → never created, muted / quiet → SILENT, otherwise LIVE), not latched from the first held event.
   */
  #emitDigest(intent: NotificationIntent): void {
    const d = this.#d;
    // Runs from a scheduler timer, outside handle(): an escaping throw would be an uncaught exception that kills the
    // process. The held events were already deduplicated, so there is nothing to roll back; the digest is dropped.
    try {
      const ctx: StageContext = { intent, prefs: d.prefs.get(intent.recipientId), mode: DeliveryMode.LIVE, now: d.clock.now() };
      const verdict = runStages(d.digestStages, ctx);
      if (verdict.kind === 'suppress') {
        this.#suppressed(intent.sourceEventId, intent.recipientId, intent.type, verdict.reason);
        return;
      }
      runStages(d.emissionStages, ctx);
      this.#announce(this.#store(intent, ctx.mode), ctx.mode);
    } catch (error) {
      d.metrics.inc('dispatch_errors_total', { kind: 'digest' });
      d.logger.error(
        { err: error, eventId: intent.sourceEventId, playerId: intent.recipientId },
        'digest dispatch failed; the grouped notification is dropped',
      );
    }
  }

  /** Renders and appends to the inbox; once this returns the dedup key must stay recorded. */
  #store(intent: NotificationIntent, mode: DeliveryMode): InboxEntry {
    const d = this.#d;
    return d.inbox.append(d.renderer.render(intent), mode);
  }

  #announce(entry: InboxEntry, mode: DeliveryMode): void {
    const d = this.#d;
    const notification = entry.notification;
    d.metrics.inc('notifications_created_total', { type: notification.type, mode });
    for (const o of this.#observers) o.onCreated?.(entry);

    const pending = d.delivery.deliver(entry);
    if (pending === undefined) return; // delivered synchronously: zero Promise allocations
    const p = pending.catch((error: unknown) => {
      d.logger.error({ err: error, notificationId: notification.id }, 'delivery crashed');
    });
    this.#inflight.add(p);
    void p.finally(() => this.#inflight.delete(p));
  }

  #suppressed(eventId: string, recipientId: PlayerId, type: NotificationType, reason: SuppressionReason): void {
    this.#d.metrics.inc('notifications_suppressed_total', { reason, type });
    if (this.#d.logger.isDebugEnabled()) {
      this.#d.logger.debug({ eventId, playerId: recipientId, type, reason }, 'notification suppressed');
    }
    for (const o of this.#observers) o.onSuppressed?.({ eventId, recipientId, type, reason });
  }
}
