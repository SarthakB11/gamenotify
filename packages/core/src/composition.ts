import { InProcessEventBus } from './application/bus/in-process-event-bus.ts';
import { DeliveryRouter } from './application/delivery/delivery-router.ts';
import { InAppChannel } from './application/delivery/in-app-channel.ts';
import { exponentialBackoff } from './application/delivery/retry-policy.ts';
import { NotificationDispatcher } from './application/dispatcher.ts';
import { NotificationFactory } from './application/notification-factory.ts';
import { GroupingStage } from './application/pipeline/grouping-stage.ts';
import { IdempotencyStage } from './application/pipeline/idempotency-stage.ts';
import { PreferenceStage } from './application/pipeline/preference-stage.ts';
import { RateLimitStage } from './application/pipeline/rate-limit-stage.ts';
import { TokenBucketLimiter } from './application/pipeline/token-bucket.ts';
import { EN_CATALOG } from './application/render/catalog-en.ts';
import { NotificationRenderer } from './application/render/renderer.ts';
import {
  ChallengeCompletedResolver,
  ItemAcquiredResolver,
  LevelUpResolver,
  PvpAttackedResolver,
  PvpDefeatedResolver,
} from './application/resolvers/game-resolvers.ts';
import { ResolverRegistry } from './application/resolvers/resolver-registry.ts';
import { FriendAcceptedResolver, FriendRequestResolver, NewFollowerResolver } from './application/resolvers/social-resolvers.ts';
import { InboxService } from './application/services/inbox-service.ts';
import { PreferenceService } from './application/services/preference-service.ts';
import { type CoreConfig, DEFAULT_CORE_CONFIG } from './config.ts';
import { ALL_EVENT_KINDS } from './domain/index.ts';
import { InMemoryDeadLetterQueue } from './infrastructure/memory/dead-letter-queue.ts';
import { InMemoryInbox } from './infrastructure/memory/in-memory-inbox.ts';
import { InMemoryPreferenceRepository } from './infrastructure/memory/preference-repository.ts';
import { InMemoryContentCatalog, InMemoryPlayerDirectory } from './infrastructure/memory/reference-data.ts';
import { SEED } from './infrastructure/memory/seed.ts';
import { TtlLruIdempotencyStore } from './infrastructure/memory/ttl-lru-idempotency-store.ts';
import { nodeScheduler, noopLogger, noopMetrics, systemClock, uuidV7Ids } from './infrastructure/system/system.ts';
import type {
  Clock,
  ContentCatalog,
  IdGenerator,
  Logger,
  Metrics,
  NotificationSender,
  PlayerDirectory,
  Scheduler,
} from './ports/index.ts';
import { GameEngine, SocialSystem } from './simulation/simulators.ts';

export interface CorePorts {
  /** The "existing notification client" — SSE gateway, console, or a test recorder. */
  readonly sender: NotificationSender;
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly clock?: Clock;
  readonly scheduler?: Scheduler;
  readonly ids?: IdGenerator;
  readonly directory?: PlayerDirectory;
  readonly catalog?: ContentCatalog;
  readonly inboxEpoch?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Deep-partial config override. */
export type CoreConfigOverrides = {
  readonly [K in keyof CoreConfig]?: CoreConfig[K] extends object ? Partial<CoreConfig[K]> : CoreConfig[K];
};

const merge = (base: CoreConfig, o: CoreConfigOverrides): CoreConfig => {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(o)) {
    const b = (base as unknown as Record<string, unknown>)[k];
    out[k] = typeof v === 'object' && v !== null && typeof b === 'object' ? { ...b, ...v } : v;
  }
  return out as unknown as CoreConfig;
};

/**
 * Composition root for the core (pure DI: explicit wiring, no container, no decorators).
 * Used by the HTTP server, the console demo and the tests.
 */
export function buildCore(ports: CorePorts, overrides: CoreConfigOverrides = {}) {
  const cfg = merge(DEFAULT_CORE_CONFIG, overrides);
  const clock = ports.clock ?? systemClock;
  const scheduler = ports.scheduler ?? nodeScheduler;
  const ids = ports.ids ?? uuidV7Ids(clock);
  const logger = ports.logger ?? noopLogger;
  const metrics = ports.metrics ?? noopMetrics;

  const directory = ports.directory ?? new InMemoryPlayerDirectory(SEED.players);
  const catalog = ports.catalog ?? new InMemoryContentCatalog(SEED.items, SEED.challenges);
  const prefs = new InMemoryPreferenceRepository();
  const inbox = new InMemoryInbox({
    capacity: cfg.inbox.capacity,
    ttlMs: cfg.inbox.ttlMs,
    clock,
    ...(ports.inboxEpoch !== undefined ? { epoch: ports.inboxEpoch } : {}),
  });
  const bus = new InProcessEventBus({ capacity: cfg.bus.capacity, batchSize: cfg.bus.batchSize, logger, metrics });

  const resolvers = new ResolverRegistry(logger)
    .register(new LevelUpResolver())
    .register(new ItemAcquiredResolver(catalog, cfg.minItemRarity, metrics))
    .register(new ChallengeCompletedResolver())
    .register(new PvpAttackedResolver())
    .register(new PvpDefeatedResolver())
    .register(new FriendRequestResolver())
    .register(new FriendAcceptedResolver())
    .register(new NewFollowerResolver());
  resolvers.assertComplete(ALL_EVENT_KINDS);

  const preferenceStage = new PreferenceStage();
  const stages = [new IdempotencyStage(new TtlLruIdempotencyStore(cfg.dedup, clock)), preferenceStage] as const;
  // After grouping: held events never spend tokens; the leading-edge intent and each digest do.
  const emissionStages = [
    new RateLimitStage(
      new TokenBucketLimiter(
        { capacity: cfg.rateLimit.capacity, refillWindowMs: cfg.rateLimit.windowMs, maxBuckets: cfg.rateLimit.maxBuckets },
        clock,
      ),
      metrics,
    ),
  ] as const;
  const grouping = new GroupingStage(cfg.grouping, clock, scheduler);
  const renderer = new NotificationRenderer(EN_CATALOG, directory, catalog, new NotificationFactory(ids, clock));
  const dlq = new InMemoryDeadLetterQueue(cfg.dlqCapacity);
  const delivery = new DeliveryRouter({
    channels: [new InAppChannel(ports.sender)],
    retry: exponentialBackoff(cfg.retry),
    dlq,
    prefs,
    inbox,
    clock,
    metrics,
    logger,
    ...(ports.sleep ? { sleep: ports.sleep } : {}),
  });
  const dispatcher = new NotificationDispatcher({
    resolvers,
    stages,
    emissionStages,
    digestStages: [preferenceStage],
    grouping,
    renderer,
    inbox,
    delivery,
    prefs,
    clock,
    metrics,
    logger,
  });
  const unsubscribe = dispatcher.start(bus);

  return {
    config: cfg,
    bus,
    dispatcher,
    grouping,
    inbox,
    dlq,
    directory,
    catalog,
    gameEngine: new GameEngine(bus, ids, clock),
    socialSystem: new SocialSystem(bus, ids, clock),
    preferences: new PreferenceService(prefs, clock),
    inboxService: new InboxService(inbox, clock),
    /** Wait until every queued event has been processed and every delivery attempt has settled. */
    async settle(): Promise<void> {
      await bus.drain();
      await dispatcher.idle();
    },
    /** Graceful shutdown: stop intake, drain, flush open groups, await deliveries. */
    async shutdown(): Promise<void> {
      await bus.drain();
      grouping.flushAll();
      unsubscribe();
      await dispatcher.idle();
    },
  };
}

export type Core = ReturnType<typeof buildCore>;
