import { SuppressionReason } from '../../domain/index.ts';
import type { IdempotencyStore } from '../../ports/index.ts';
import { CONTINUE, type PipelineStage, type StageContext, suppress, type Verdict } from './stage.ts';

const DUPLICATE = suppress(SuppressionReason.DUPLICATE);

/** At-least-once producers may redeliver an event; each (event, recipient, type) notifies at most once. */
export class IdempotencyStage implements PipelineStage {
  readonly name = 'idempotency';
  readonly #store: IdempotencyStore;

  constructor(store: IdempotencyStore) {
    this.#store = store;
  }

  apply({ intent }: StageContext): Verdict {
    const key = `${intent.sourceEventId}|${intent.recipientId}|${intent.type}`;
    return this.#store.firstSeen(key) ? CONTINUE : DUPLICATE;
  }
}
