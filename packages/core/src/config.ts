import { type ItemRarity, ItemRarity as Rarity } from './domain/index.ts';

/** Tunables for the core. Apps map env vars onto this; tests override per case. */
export interface CoreConfig {
  readonly bus: { readonly capacity: number; readonly batchSize: number };
  readonly dedup: { readonly ttlMs: number; readonly maxKeys: number };
  readonly rateLimit: { readonly capacity: number; readonly windowMs: number; readonly maxBuckets: number };
  readonly grouping: { readonly windowMs: number; readonly maxWindowMs: number };
  readonly inbox: { readonly capacity: number; readonly ttlMs: number };
  readonly retry: { readonly maxAttempts: number; readonly baseMs: number; readonly capMs: number };
  readonly dlqCapacity: number;
  readonly minItemRarity: ItemRarity;
}

export const DEFAULT_CORE_CONFIG: CoreConfig = Object.freeze({
  bus: { capacity: 65_536, batchSize: 512 },
  dedup: { ttlMs: 10 * 60_000, maxKeys: 100_000 },
  rateLimit: { capacity: 20, windowMs: 60_000, maxBuckets: 200_000 },
  grouping: { windowMs: 10_000, maxWindowMs: 60_000 },
  inbox: { capacity: 200, ttlMs: 7 * 24 * 60 * 60_000 },
  retry: { maxAttempts: 3, baseMs: 50, capMs: 2_000 },
  dlqCapacity: 1_000,
  minItemRarity: Rarity.RARE,
});
