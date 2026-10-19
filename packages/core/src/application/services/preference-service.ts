import {
  ALL_CATEGORIES,
  ALL_NOTIFICATION_TYPES,
  err,
  isValidTimeZone,
  type NotificationCategory,
  type NotificationType,
  type PlayerId,
  parseClockTime,
  type QuietHours,
  type Result,
  type UserPreferences,
} from '../../domain/index.ts';
import type { Clock, PreferenceRepository } from '../../ports/index.ts';

/** RFC 7396 merge-patch shape for preferences (null clears a field / override). */
export interface PreferencesPatch {
  readonly categories?: Partial<Record<NotificationCategory, boolean>>;
  readonly typeOverrides?: Partial<Record<NotificationType, boolean | null>>;
  readonly mutedUntil?: number | null;
  readonly muteForMinutes?: number;
  readonly quietHours?: QuietHours | null;
}

export type PreferenceError =
  | { readonly code: 'VERSION_CONFLICT' }
  | { readonly code: 'INVALID'; readonly field: string; readonly message: string };

export class PreferenceService {
  readonly #repo: PreferenceRepository;
  readonly #clock: Clock;

  constructor(repo: PreferenceRepository, clock: Clock) {
    this.#repo = repo;
    this.#clock = clock;
  }

  get(player: PlayerId): UserPreferences {
    return this.#repo.get(player);
  }

  patch(player: PlayerId, patch: PreferencesPatch, expectedVersion?: number): Result<UserPreferences, PreferenceError> {
    const current = this.#repo.get(player);
    const invalid = validate(patch);
    if (invalid) return err(invalid);

    const categories = { ...current.categories };
    for (const c of ALL_CATEGORIES) {
      const v = patch.categories?.[c];
      if (v !== undefined) categories[c] = v;
    }

    const typeOverrides: Partial<Record<NotificationType, boolean>> = { ...current.typeOverrides };
    for (const t of ALL_NOTIFICATION_TYPES) {
      const v = patch.typeOverrides?.[t];
      if (v === null) delete typeOverrides[t];
      else if (v !== undefined) typeOverrides[t] = v;
    }

    let mutedUntil = current.mutedUntil;
    if (patch.mutedUntil !== undefined) mutedUntil = patch.mutedUntil;
    if (patch.muteForMinutes !== undefined) mutedUntil = this.#clock.now() + patch.muteForMinutes * 60_000;

    const next: UserPreferences = Object.freeze({
      playerId: player,
      categories: Object.freeze(categories),
      typeOverrides: Object.freeze(typeOverrides),
      mutedUntil,
      quietHours: patch.quietHours === undefined ? current.quietHours : patch.quietHours,
      version: current.version + 1,
    });

    const saved = this.#repo.save(next, expectedVersion ?? current.version);
    return saved.ok ? saved : err({ code: 'VERSION_CONFLICT' });
  }
}

const validate = (p: PreferencesPatch): PreferenceError | null => {
  for (const key of Object.keys(p.categories ?? {})) {
    if (!ALL_CATEGORIES.includes(key as NotificationCategory)) {
      return { code: 'INVALID', field: `categories.${key}`, message: 'unknown category' };
    }
  }
  for (const key of Object.keys(p.typeOverrides ?? {})) {
    if (!ALL_NOTIFICATION_TYPES.includes(key as NotificationType)) {
      return { code: 'INVALID', field: `typeOverrides.${key}`, message: 'unknown notification type' };
    }
  }
  if (
    p.muteForMinutes !== undefined &&
    (!Number.isFinite(p.muteForMinutes) || p.muteForMinutes < 0 || p.muteForMinutes > 60 * 24 * 30)
  ) {
    return { code: 'INVALID', field: 'muteForMinutes', message: 'must be between 0 and 43200' };
  }
  if (p.quietHours) {
    const q = p.quietHours;
    try {
      parseClockTime(q.start);
      parseClockTime(q.end);
    } catch (e) {
      return { code: 'INVALID', field: 'quietHours', message: (e as Error).message };
    }
    if (!isValidTimeZone(q.timeZone)) return { code: 'INVALID', field: 'quietHours.timeZone', message: 'unknown IANA time zone' };
  }
  return null;
};
