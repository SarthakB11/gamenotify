import { type NotificationIntent, SuppressionReason } from '../../domain/index.ts';
import type { IdempotencyStore } from '../../ports/index.ts';
import { CONTINUE, type PipelineStage, type StageContext, suppress, type Verdict } from './stage.ts';

const keyOf = (i: NotificationIntent): string => `${i.sourceEventId}|${i.recipientId}|${i.type}`;
const DUPLICATE = suppress(SuppressionReason.DUPLICATE);

/** At-least-once producers may redeliver an event; each (event, recipient, type) notifies at most once. */
export class IdempotencyStage implements PipelineStage {
  readonly name = 'idempotency';
  readonly #store: IdempotencyStore;

  constructor(store: IdempotencyStore) {
    this.#store = store;
  }

  apply({ intent }: StageContext): Verdict {
    return this.#store.firstSeen(keyOf(intent)) ? CONTINUE : DUPLICATE;
  }

  /** Mark-then-rollback: the dispatcher calls this when a later step threw, so the producer's retry is processed. */
  rollback({ intent }: StageContext): void {
    this.#store.release(keyOf(intent));
  }
}
