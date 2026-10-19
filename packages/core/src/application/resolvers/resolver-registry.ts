import type { EventKind, PlatformEvent } from '../../domain/index.ts';
import type { Logger } from '../../ports/index.ts';
import type { IntentResolver, Resolution } from './resolver.ts';

const NONE: readonly Resolution[] = Object.freeze([]);

export class ResolverRegistry {
  readonly #map = new Map<EventKind, IntentResolver>();
  readonly #log: Logger;

  constructor(logger: Logger) {
    this.#log = logger;
  }

  register<K extends EventKind>(resolver: IntentResolver<K>): this {
    if (this.#map.has(resolver.kind)) throw new Error(`Duplicate resolver for "${resolver.kind}"`);
    this.#map.set(resolver.kind, resolver as unknown as IntentResolver);
    return this;
  }

  resolve(event: PlatformEvent): readonly Resolution[] {
    const resolver = this.#map.get(event.kind);
    if (!resolver) {
      this.#log.warn({ kind: event.kind, eventId: event.eventId }, 'no resolver registered');
      return NONE;
    }
    return resolver.resolve(event as never);
  }

  /** Fail fast at boot if any event kind has no resolver. */
  assertComplete(kinds: readonly EventKind[]): void {
    const missing = kinds.filter((k) => !this.#map.has(k));
    if (missing.length > 0) throw new Error(`Missing resolvers for: ${missing.join(', ')}`);
  }
}
