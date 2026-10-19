import type { PlayerId } from './ids.ts';
import type { NotificationCategory, NotificationType } from './notification-type.ts';

/** "HH:MM" 24h local time. */
export type ClockTime = string;

export interface QuietHours {
  readonly start: ClockTime;
  readonly end: ClockTime;
  /** IANA time zone, e.g. "Asia/Kolkata". */
  readonly timeZone: string;
}

/**
 * The brief's "simple dictionary or map" of category toggles, extended with per-type overrides,
 * a mute-until timestamp and quiet hours.
 */
export interface UserPreferences {
  readonly playerId: PlayerId;
  readonly categories: Readonly<Record<NotificationCategory, boolean>>;
  readonly typeOverrides: Readonly<Partial<Record<NotificationType, boolean>>>;
  readonly mutedUntil: number | null;
  readonly quietHours: QuietHours | null;
  /** Optimistic-concurrency version (ETag). */
  readonly version: number;
}

const DEFAULT_CATEGORIES = Object.freeze({ GAME: true, SOCIAL: true });
const NO_OVERRIDES = Object.freeze({});

/** Defaults share frozen sub-objects, so the hot path allocates one small object per unknown player lookup. */
export const defaultPreferences = (playerId: PlayerId): UserPreferences =>
  Object.freeze({
    playerId,
    categories: DEFAULT_CATEGORIES,
    typeOverrides: NO_OVERRIDES,
    mutedUntil: null,
    quietHours: null,
    version: 0,
  });

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const parseClockTime = (t: ClockTime): number => {
  const m = CLOCK_RE.exec(t);
  if (!m) throw new RangeError(`Invalid time "${t}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
};

export const isValidTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
