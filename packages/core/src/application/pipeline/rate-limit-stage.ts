import { DeliveryMode, Priority, TYPE_META } from '../../domain/index.ts';
import type { Metrics } from '../../ports/index.ts';
import { CONTINUE, type PipelineStage, type StageContext, type Verdict } from './stage.ts';
import type { TokenBucketLimiter } from './token-bucket.ts';

/** Over the per-player/per-category budget, notifications are downgraded to SILENT — never dropped. */
export class RateLimitStage implements PipelineStage {
  readonly name = 'rate-limit';
  readonly #limiter: TokenBucketLimiter;
  readonly #metrics: Metrics;

  constructor(limiter: TokenBucketLimiter, metrics: Metrics) {
    this.#limiter = limiter;
    this.#metrics = metrics;
  }

  apply(ctx: StageContext): Verdict {
    if (ctx.mode !== DeliveryMode.LIVE) return CONTINUE;
    const meta = TYPE_META[ctx.intent.type];
    if (meta.priority >= Priority.HIGH) return CONTINUE;
    if (!this.#limiter.take(`${ctx.intent.recipientId}|${meta.category}`)) {
      ctx.mode = DeliveryMode.SILENT;
      this.#metrics.inc('rate_limited_total', { category: meta.category });
    }
    return CONTINUE;
  }
}
