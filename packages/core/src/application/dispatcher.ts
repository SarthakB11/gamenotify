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
    deps.grouping.onFlush((intent, mode) => this.#emitDigest(intent, mode));
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
      const verdict = runStages(d.stages, ctx);
      if (verdict.kind === 'suppress') {
        this.#suppressed(event.eventId, r.recipientId, r.type, verdict.reason);
        continue;
      }
      if (d.grouping.offer(ctx) === 'held') {
        this.#suppressed(event.eventId, r.recipientId, r.type, 'GROUPED');
        continue;
      }
      // Only what is emitted (leading edge, ungrouped) spends rate-limit tokens; held events never do.
      runStages(d.emissionStages, ctx);
      this.#finish(r, ctx.mode);
    }
    d.metrics.observe('dispatch_latency_seconds', (performance.now() - t0) / 1000);
  }

  /** Resolves when no delivery attempt is in flight (graceful shutdown, tests). */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  /** Trailing digest: it is emitted, so it spends a rate-limit token like any other live notification. */
  #emitDigest(intent: NotificationIntent, mode: DeliveryMode): void {
    const d = this.#d;
    const ctx: StageContext = { intent, prefs: d.prefs.get(intent.recipientId), mode, now: d.clock.now() };
    runStages(d.emissionStages, ctx);
    this.#finish(intent, ctx.mode);
  }

  #finish(intent: NotificationIntent, mode: DeliveryMode): void {
    const d = this.#d;
    const notification = d.renderer.render(intent);
    const entry = d.inbox.append(notification, mode);
    d.metrics.inc('notifications_created_total', { type: notification.type, mode });
    for (const o of this.#observers) o.onCreated?.(entry);
    if (mode !== DeliveryMode.LIVE) return;

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
