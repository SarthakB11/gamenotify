import type { DeadLetter, DeadLetterQueue } from '../../ports/index.ts';

/** Bounded: keeps the most recent `capacity` failures. */
export class InMemoryDeadLetterQueue implements DeadLetterQueue {
  readonly #items: DeadLetter[] = [];
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.#items.length;
  }

  put(item: DeadLetter): void {
    if (this.#items.length >= this.#capacity) this.#items.shift();
    this.#items.push(item);
  }

  list(limit: number): readonly DeadLetter[] {
    return this.#items.slice(-limit).reverse();
  }
}
