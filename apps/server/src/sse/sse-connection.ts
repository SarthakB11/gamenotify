import type { ServerResponse } from 'node:http';
import type { PlayerId } from '@gamenotify/core';

let nextId = 0;

/**
 * One EventSource connection. Two concerns:
 *  1. Handshake buffering: while BUFFERING (replay in progress), live frames are parked and de-duplicated by seq.
 *  2. Back-pressure: honours writableNeedDrain/'drain'; a consumer that falls more than `maxQueued`
 *     frames behind is evicted (it will reconnect and replay) — frames are never silently dropped.
 */
export class SseConnection {
  readonly id = ++nextId;
  readonly playerId: PlayerId;
  readonly openedAt: number;
  lastSeq = 0;
  lastWriteAt: number;
  #state: 'BUFFERING' | 'LIVE' | 'CLOSED' = 'BUFFERING';
  readonly #res: ServerResponse;
  readonly #pending: { seq: number; frame: string }[] = [];
  readonly #queue: string[] = [];
  readonly #maxQueued: number;
  readonly #now: () => number;
  readonly #onEvict: (c: SseConnection, reason: string) => void;
  #corked = false;

  constructor(opts: {
    playerId: PlayerId;
    res: ServerResponse;
    maxQueued: number;
    now: () => number;
    onEvict: (c: SseConnection, reason: string) => void;
  }) {
    this.playerId = opts.playerId;
    this.#res = opts.res;
    this.#maxQueued = opts.maxQueued;
    this.#now = opts.now;
    this.#onEvict = opts.onEvict;
    this.openedAt = this.lastWriteAt = opts.now();
    this.#res.on('drain', this.#flushQueue);
  }

  get state(): 'BUFFERING' | 'LIVE' | 'CLOSED' {
    return this.#state;
  }

  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Deliver a notification frame (ordered by seq, de-duplicated against replay).
   * Returns true only if the frame was written to the socket now. A frame parked during the handshake or queued
   * behind back-pressure (or dropped with a slow-consumer eviction) returns false: it is not delivered yet, and
   * the client gets it from the next replay if the connection does not live to flush it.
   */
  deliver(seq: number, frame: string): boolean {
    if (this.#state === 'CLOSED') return false;
    if (this.#state === 'BUFFERING') {
      this.#pending.push({ seq, frame });
      return false;
    }
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    return this.write(frame);
  }

  /** End of handshake: flush frames that arrived during replay, skipping any the replay already sent. */
  goLive(): void {
    if (this.#state !== 'BUFFERING') return;
    this.#state = 'LIVE';
    this.#pending.sort((a, b) => a.seq - b.seq);
    for (const p of this.#pending) this.deliver(p.seq, p.frame);
    this.#pending.length = 0;
  }

  /**
   * Raw write with back-pressure handling and per-tick write coalescing (cork/uncork).
   * Returns true if the chunk went to the socket, false if it was queued, rejected as slow-consumer or closed.
   */
  write(chunk: string): boolean {
    if (this.#state === 'CLOSED') return false;
    if (this.#queue.length > 0 || this.#res.writableNeedDrain) {
      if (this.#queue.length >= this.#maxQueued) {
        this.close('slow_consumer');
        return false;
      }
      this.#queue.push(chunk);
      return false;
    }
    if (!this.#corked) {
      this.#corked = true;
      this.#res.cork();
      process.nextTick(this.#uncork);
    }
    this.#res.write(chunk);
    this.lastWriteAt = this.#now();
    return true;
  }

  close(reason?: string): void {
    if (this.#state === 'CLOSED') return;
    this.#state = 'CLOSED';
    this.#res.off('drain', this.#flushQueue);
    this.#queue.length = 0;
    if (reason) this.#onEvict(this, reason);
    if (!this.#res.writableEnded) this.#res.end();
  }

  readonly #uncork = (): void => {
    this.#corked = false;
    if (!this.#res.writableEnded) this.#res.uncork();
  };

  readonly #flushQueue = (): void => {
    while (this.#queue.length > 0 && !this.#res.writableNeedDrain && this.#state !== 'CLOSED') {
      this.#res.write(this.#queue.shift() as string);
      this.lastWriteAt = this.#now();
    }
  };
}
