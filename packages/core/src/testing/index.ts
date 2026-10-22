import { EventId, type InboxEntry, NotificationId } from '../domain/index.ts';
import type {
  Clock,
  DeliveryResult,
  IdGenerator,
  Logger,
  Metrics,
  NotificationSender,
  Scheduler,
  TimerHandle,
} from '../ports/index.ts';

/** Deterministic clock for tests. */
export class FakeClock implements Clock {
  #now: number;
  constructor(start = Date.UTC(2026, 9, 18, 12, 0, 0)) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  set(ms: number): void {
    this.#now = ms;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

interface Timer {
  at: number;
  fn: () => void;
  cancelled: boolean;
}

/** Scheduler driven by a FakeClock: `advance(ms)` fires due timers in order. */
export class ManualScheduler implements Scheduler {
  readonly #clock: FakeClock;
  #timers: Timer[] = [];
  constructor(clock: FakeClock) {
    this.#clock = clock;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const t: Timer = { at: this.#clock.now() + ms, fn, cancelled: false };
    this.#timers.push(t);
    return { cancel: () => (t.cancelled = true) };
  }
  get pending(): number {
    return this.#timers.filter((t) => !t.cancelled).length;
  }
  advance(ms: number): void {
    const target = this.#clock.now() + ms;
    for (;;) {
      const due = this.#timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      if (due.at > this.#clock.now()) this.#clock.set(due.at);
      due.fn();
    }
    this.#clock.set(target);
  }
}

/** Sequential, readable ids: evt-1, ntf-1 ... */
export const seqIds = (): IdGenerator => {
  let e = 0;
  let n = 0;
  return { eventId: () => EventId(`evt-${++e}`), notificationId: () => NotificationId(`ntf-${++n}`) };
};

/** Records everything "delivered" to the fake game client. */
export class RecordingSender implements NotificationSender {
  readonly name = 'recording';
  carriesSilent = false;
  readonly sent: InboxEntry[] = [];
  result: DeliveryResult | (() => DeliveryResult) = 'DELIVERED';
  send(entry: InboxEntry): DeliveryResult {
    const r = typeof this.result === 'function' ? this.result() : this.result;
    if (r === 'DELIVERED') this.sent.push(entry);
    return r;
  }
  messages(): string[] {
    return this.sent.map((e) => e.notification.message);
  }
  clear(): void {
    this.sent.length = 0;
  }
}

export class MemoryLogger implements Logger {
  readonly lines: { level: string; fields: Record<string, unknown>; msg?: string }[] = [];
  debug(fields: Record<string, unknown>, msg?: string): void {
    this.lines.push({ level: 'debug', fields, ...(msg ? { msg } : {}) });
  }
  info(fields: Record<string, unknown>, msg?: string): void {
    this.lines.push({ level: 'info', fields, ...(msg ? { msg } : {}) });
  }
  warn(fields: Record<string, unknown>, msg?: string): void {
    this.lines.push({ level: 'warn', fields, ...(msg ? { msg } : {}) });
  }
  error(fields: Record<string, unknown>, msg?: string): void {
    this.lines.push({ level: 'error', fields, ...(msg ? { msg } : {}) });
  }
  isDebugEnabled(): boolean {
    return true;
  }
}

export class MemoryMetrics implements Metrics {
  readonly counters = new Map<string, number>();
  readonly gauges = new Map<string, number>();
  readonly observations = new Map<string, number[]>();
  static key(name: string, labels?: Record<string, string>): string {
    if (!labels) return name;
    const l = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    return `${name}{${l}}`;
  }
  inc(name: string, labels?: Record<string, string>, by = 1): void {
    const k = MemoryMetrics.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }
  observe(name: string, value: number): void {
    const arr = this.observations.get(name) ?? [];
    arr.push(value);
    this.observations.set(name, arr);
  }
  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.set(MemoryMetrics.key(name, labels), value);
  }
  count(name: string, labels?: Record<string, string>): number {
    return this.counters.get(MemoryMetrics.key(name, labels)) ?? 0;
  }
}
