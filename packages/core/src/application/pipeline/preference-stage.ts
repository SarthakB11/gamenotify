import { DeliveryMode, Priority, SuppressionReason, TYPE_META } from '../../domain/index.ts';
import { isQuietTime } from './quiet-hours.ts';
import { CONTINUE, type PipelineStage, type StageContext, suppress, type Verdict } from './stage.ts';

const TYPE_DISABLED = suppress(SuppressionReason.TYPE_DISABLED);
const CATEGORY_DISABLED = suppress(SuppressionReason.CATEGORY_DISABLED);

/**
 * Specification-style policy, most specific rule first:
 *   1. per-type override (false → suppress, true → enabled even if its category is off)
 *   2. category toggle (the brief's simple map)
 *   3. mute-until → SILENT
 *   4. quiet hours → SILENT (HIGH priority bypasses)
 * "Disabled" means never created; "muted / quiet" means stored in the inbox without a live push.
 */
export class PreferenceStage implements PipelineStage {
  readonly name = 'preferences';

  apply(ctx: StageContext): Verdict {
    const { intent, prefs, now } = ctx;
    const meta = TYPE_META[intent.type];

    const override = prefs.typeOverrides[intent.type];
    if (override === false) return TYPE_DISABLED;
    if (override !== true && prefs.categories[meta.category] === false) return CATEGORY_DISABLED;

    if (prefs.mutedUntil !== null && prefs.mutedUntil > now) {
      ctx.mode = DeliveryMode.SILENT;
    } else if (prefs.quietHours !== null && meta.priority < Priority.HIGH && isQuietTime(prefs.quietHours, now)) {
      ctx.mode = DeliveryMode.SILENT;
    }
    return CONTINUE;
  }
}
