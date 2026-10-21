import type { DeliveryMode, NotificationIntent, SuppressionReason, UserPreferences } from '../../domain/index.ts';

export type Verdict = { readonly kind: 'continue' } | { readonly kind: 'suppress'; readonly reason: SuppressionReason };

export const CONTINUE: Verdict = Object.freeze({ kind: 'continue' });
export const suppress = (reason: SuppressionReason): Verdict => ({ kind: 'suppress', reason });

export interface StageContext {
  readonly intent: NotificationIntent;
  readonly prefs: UserPreferences;
  /** Stages may downgrade LIVE → SILENT (store, don't push). Nothing upgrades SILENT → LIVE. */
  mode: DeliveryMode;
  readonly now: number;
}

/** Chain of Responsibility link: one concern per stage, synchronous and allocation-free on the happy path. */
export interface PipelineStage {
  readonly name: string;
  apply(ctx: StageContext): Verdict;
  /** Undo this stage's side effects when a later step threw for the same context (optional). */
  rollback?(ctx: StageContext): void;
}

export const runStages = (stages: readonly PipelineStage[], ctx: StageContext): Verdict => {
  for (const stage of stages) {
    const v = stage.apply(ctx);
    if (v.kind === 'suppress') return v;
  }
  return CONTINUE;
};
