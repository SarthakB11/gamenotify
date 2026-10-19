export interface RetryPolicy {
  readonly maxAttempts: number;
  /** Delay before retry number `attempt` (1-based). */
  delay(attempt: number): number;
}

/** Exponential backoff with full jitter (AWS Architecture Blog): random(0, min(cap, base · 2^attempt)). */
export const exponentialBackoff = (
  opts: { maxAttempts: number; baseMs: number; capMs: number },
  random: () => number = Math.random,
): RetryPolicy => ({
  maxAttempts: Math.max(1, opts.maxAttempts),
  delay: (attempt) => Math.floor(random() * Math.min(opts.capMs, opts.baseMs * 2 ** attempt)),
});
