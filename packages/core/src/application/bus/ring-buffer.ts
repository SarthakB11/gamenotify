/**
 * Fixed-capacity FIFO queue. O(1) push/shift, no allocation after construction.
 * Capacity is rounded up to a power of two so the index wrap is a bit-mask.
 */
export class RingBuffer<T> {
  readonly #slots: (T | undefined)[];
  readonly #mask: number;
  #head = 0;
  #size = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be >= 1');
    const cap = 2 ** Math.ceil(Math.log2(capacity));
    this.#slots = new Array<T | undefined>(cap).fill(undefined);
    this.#mask = cap - 1;
  }

  get size(): number {
    return this.#size;
  }

  get capacity(): number {
    return this.#mask + 1;
  }

  /** Returns false when full (caller decides the overflow policy). */
  push(item: T): boolean {
    if (this.#size > this.#mask) return false;
    this.#slots[(this.#head + this.#size) & this.#mask] = item;
    this.#size++;
    return true;
  }

  peek(): T | undefined {
    return this.#size === 0 ? undefined : this.#slots[this.#head];
  }

  shift(): T | undefined {
    if (this.#size === 0) return undefined;
    const item = this.#slots[this.#head];
    this.#slots[this.#head] = undefined; // release reference for GC
    this.#head = (this.#head + 1) & this.#mask;
    this.#size--;
    return item;
  }
}
