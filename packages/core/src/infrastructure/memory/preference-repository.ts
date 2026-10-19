import { defaultPreferences, err, ok, type PlayerId, type Result, type UserPreferences } from '../../domain/index.ts';
import type { PreferenceRepository } from '../../ports/index.ts';

/** The brief's "simple dictionary or map" — literally a Map, behind a port. */
export class InMemoryPreferenceRepository implements PreferenceRepository {
  readonly #store = new Map<PlayerId, UserPreferences>();

  get(id: PlayerId): UserPreferences {
    return this.#store.get(id) ?? defaultPreferences(id);
  }

  save(prefs: UserPreferences, expectedVersion: number): Result<UserPreferences, 'VERSION_CONFLICT'> {
    const current = this.get(prefs.playerId);
    if (current.version !== expectedVersion) return err('VERSION_CONFLICT');
    this.#store.set(prefs.playerId, prefs);
    return ok(prefs);
  }
}
