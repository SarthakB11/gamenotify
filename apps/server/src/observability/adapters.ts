import type { Labels, Logger, Metrics } from '@gamenotify/core';
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';

/** Adapts pino to the core Logger port. */
/** Structural subset of pino / FastifyBaseLogger. */
interface PinoLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  level: string;
}

export const pinoAdapter = (log: PinoLike): Logger => ({
  debug: (f, m) => log.debug(f, m),
  info: (f, m) => log.info(f, m),
  warn: (f, m) => log.warn(f, m),
  error: (f, m) => log.error(f, m),
  isDebugEnabled: () => log.level === 'debug' || log.level === 'trace',
});

const HELP: Record<string, string> = {
  events_received_total: 'Platform events consumed by the dispatcher',
  bus_rejected_total: 'Events rejected by the bus (back-pressure)',
  bus_handler_errors_total: 'Event handlers that threw',
  bus_queue_depth: 'Events waiting in the in-process bus',
  notifications_created_total: 'Notifications rendered and stored',
  notifications_suppressed_total: 'Notifications not created, by reason',
  notifications_delivered_total: 'Delivery attempts by channel and result',
  rate_limited_total: 'Notifications downgraded to silent by the rate limiter',
  dispatch_latency_seconds: 'Event → send() latency inside the process',
  dlq_size: 'Dead-lettered deliveries',
  catalog_miss_total: 'Lookups for unknown catalog items',
  sse_connections: 'Open SSE connections',
  sse_evictions_total: 'SSE connections closed by the server',
  sse_replayed_total: 'Notifications replayed on reconnect',
  sse_resync_total: 'Reconnects that required a resync',
};

/**
 * Adapts prom-client to the core Metrics port. Metrics are created lazily on first use;
 * label names are taken from that first call (the core always uses consistent label sets).
 */
export class PromMetrics implements Metrics {
  readonly #registry: Registry;
  readonly #counters = new Map<string, Counter>();
  readonly #gauges = new Map<string, Gauge>();
  readonly #histograms = new Map<string, Histogram>();

  constructor(registry: Registry) {
    this.#registry = registry;
  }

  inc(name: string, labels?: Labels, by = 1): void {
    let c = this.#counters.get(name);
    if (!c) {
      c = new Counter({ name, help: HELP[name] ?? name, labelNames: Object.keys(labels ?? {}), registers: [this.#registry] });
      this.#counters.set(name, c);
    }
    labels ? c.inc(labels, by) : c.inc(by);
  }

  gauge(name: string, value: number, labels?: Labels): void {
    let g = this.#gauges.get(name);
    if (!g) {
      g = new Gauge({ name, help: HELP[name] ?? name, labelNames: Object.keys(labels ?? {}), registers: [this.#registry] });
      this.#gauges.set(name, g);
    }
    labels ? g.set(labels, value) : g.set(value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    let h = this.#histograms.get(name);
    if (!h) {
      h = new Histogram({
        name,
        help: HELP[name] ?? name,
        labelNames: Object.keys(labels ?? {}),
        buckets: [0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.05],
        registers: [this.#registry],
      });
      this.#histograms.set(name, h);
    }
    labels ? h.observe(labels, value) : h.observe(value);
  }
}
