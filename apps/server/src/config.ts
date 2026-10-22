import { randomBytes } from 'node:crypto';
import { type CoreConfigOverrides, DEFAULT_CORE_CONFIG, parseRarity } from '@gamenotify/core';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly env: 'development' | 'production' | 'test';
  readonly logLevel: string;
  readonly authSecret: string;
  readonly authSecretGenerated: boolean;
  readonly internalApiKey: string;
  readonly webDistDir: string | null;
  /** Extra generated players (ids 1001..) for load testing. */
  readonly syntheticPlayers: number;
  readonly sse: {
    readonly heartbeatMs: number;
    readonly maxBufferedFrames: number;
    readonly maxConnectionsPerPlayer: number;
    readonly replayLimit: number;
    readonly retryMs: number;
  };
  readonly core: CoreConfigOverrides;
}

/** Published in the repo, so never acceptable as a production secret. */
export const DEV_INTERNAL_KEY = 'dev-internal-key';
const MIN_SECRET_LENGTH = 16;

type Env = Record<string, string | undefined>;

const int = (env: Env, key: string, fallback: number, min = 0): number => {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`Invalid ${key}="${raw}": expected an integer >= ${min}`);
  return n;
};

/** Parse and validate configuration once at boot; fail fast with a readable error. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as ServerConfig['env'];
  if (!['development', 'production', 'test'].includes(nodeEnv)) throw new Error(`Invalid NODE_ENV="${nodeEnv}"`);
  if (nodeEnv === 'production' && !env.AUTH_SECRET) throw new Error('AUTH_SECRET is required in production');
  if (nodeEnv === 'production' && !env.INTERNAL_API_KEY) throw new Error('INTERNAL_API_KEY is required in production');
  if (nodeEnv === 'production') {
    if (env.INTERNAL_API_KEY === DEV_INTERNAL_KEY) {
      throw new Error('INTERNAL_API_KEY is still the public development default; set a private value in production');
    }
    for (const key of ['AUTH_SECRET', 'INTERNAL_API_KEY'] as const) {
      if ((env[key] ?? '').length < MIN_SECRET_LENGTH) {
        throw new Error(`${key} must be at least ${MIN_SECRET_LENGTH} characters in production`);
      }
    }
  }
  const d = DEFAULT_CORE_CONFIG;
  const groupWindowMs = int(env, 'GROUP_WINDOW_MS', d.grouping.windowMs, 1);
  const groupMaxExplicit = env.GROUP_MAX_WINDOW_MS !== undefined && env.GROUP_MAX_WINDOW_MS !== '';
  // A long window alone must not trip the stage's windowMs <= maxWindowMs check, so the default cap follows it.
  const groupMaxWindowMs = int(env, 'GROUP_MAX_WINDOW_MS', Math.max(d.grouping.maxWindowMs, groupWindowMs), 1);
  if (groupMaxExplicit && groupMaxWindowMs < groupWindowMs) {
    throw new Error(`GROUP_MAX_WINDOW_MS (${groupMaxWindowMs}) must be >= GROUP_WINDOW_MS (${groupWindowMs})`);
  }

  return Object.freeze({
    // Loopback unless production: the dev login lets anyone who can reach the port impersonate any player.
    host: env.HOST ?? (nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1'),
    port: int(env, 'PORT', 3000),
    env: nodeEnv,
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    authSecret: env.AUTH_SECRET ?? randomBytes(32).toString('hex'),
    authSecretGenerated: !env.AUTH_SECRET,
    internalApiKey: env.INTERNAL_API_KEY ?? (nodeEnv === 'production' ? '' : DEV_INTERNAL_KEY),
    webDistDir: env.WEB_DIST_DIR ?? null,
    syntheticPlayers: int(env, 'SYNTHETIC_PLAYERS', 0),
    sse: {
      heartbeatMs: int(env, 'SSE_HEARTBEAT_MS', 15_000, 100),
      maxBufferedFrames: int(env, 'SSE_MAX_BUFFERED_FRAMES', 1_000, 1),
      maxConnectionsPerPlayer: int(env, 'SSE_MAX_CONN_PER_PLAYER', 5, 1),
      replayLimit: int(env, 'SSE_REPLAY_LIMIT', 500, 1),
      retryMs: int(env, 'SSE_RETRY_MS', 3_000, 100),
    },
    core: {
      bus: { capacity: int(env, 'BUS_CAPACITY', d.bus.capacity, 1), batchSize: int(env, 'BUS_BATCH', d.bus.batchSize, 1) },
      dedup: { ttlMs: int(env, 'DEDUP_TTL_MS', d.dedup.ttlMs, 1), maxKeys: int(env, 'DEDUP_MAX_KEYS', d.dedup.maxKeys, 1) },
      rateLimit: {
        capacity: int(env, 'RATE_CAPACITY', d.rateLimit.capacity, 1),
        windowMs: int(env, 'RATE_WINDOW_MS', d.rateLimit.windowMs, 1),
      },
      grouping: { windowMs: groupWindowMs, maxWindowMs: groupMaxWindowMs },
      inbox: { capacity: int(env, 'INBOX_CAPACITY', d.inbox.capacity, 1), ttlMs: int(env, 'INBOX_TTL_MS', d.inbox.ttlMs, 1) },
      minItemRarity: env.MIN_ITEM_RARITY ? parseRarity(env.MIN_ITEM_RARITY) : d.minItemRarity,
    },
  });
}
