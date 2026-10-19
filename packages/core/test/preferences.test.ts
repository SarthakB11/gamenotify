import { describe, expect, it } from 'vitest';
import {
  DeliveryMode,
  defaultPreferences,
  EventId,
  InMemoryPreferenceRepository,
  inWindow,
  isQuietTime,
  localMinutes,
  type NotificationIntent,
  type NotificationType,
  PlayerId,
  PreferenceService,
  PreferenceStage,
  type StageContext,
  type UserPreferences,
} from '../src/index.ts';
import { FakeClock } from '../src/testing/index.ts';

const intent = (type: NotificationType): NotificationIntent => ({
  recipientId: PlayerId(1),
  type,
  params: {},
  sourceEventId: EventId('e'),
  occurredAt: 0,
});

// 2026-10-18T12:00:00Z == 17:30 in Asia/Kolkata
const NOON_UTC = Date.UTC(2026, 9, 18, 12, 0);

const run = (type: NotificationType, p: Partial<UserPreferences>, now = NOON_UTC) => {
  const ctx: StageContext = {
    intent: intent(type),
    prefs: { ...defaultPreferences(PlayerId(1)), ...p },
    mode: DeliveryMode.LIVE,
    now,
  };
  const verdict = new PreferenceStage().apply(ctx);
  return { verdict, mode: ctx.mode };
};

describe('PreferenceStage precedence', () => {
  it('enabled by default', () => {
    expect(run('LEVEL_UP', {})).toEqual({ verdict: { kind: 'continue' }, mode: 'LIVE' });
  });

  it('category off suppresses', () => {
    expect(run('FRIEND_REQUEST', { categories: { GAME: true, SOCIAL: false } }).verdict).toEqual({
      kind: 'suppress',
      reason: 'CATEGORY_DISABLED',
    });
  });

  it('type override false beats an enabled category', () => {
    expect(run('PVP_ATTACKED', { typeOverrides: { PVP_ATTACKED: false } }).verdict).toEqual({
      kind: 'suppress',
      reason: 'TYPE_DISABLED',
    });
  });

  it('type override true beats a disabled category', () => {
    expect(
      run('FRIEND_REQUEST', { categories: { GAME: true, SOCIAL: false }, typeOverrides: { FRIEND_REQUEST: true } }).verdict.kind,
    ).toBe('continue');
  });

  it('mute downgrades to SILENT until it expires', () => {
    expect(run('LEVEL_UP', { mutedUntil: NOON_UTC + 1 }).mode).toBe('SILENT');
    expect(run('LEVEL_UP', { mutedUntil: NOON_UTC }).mode).toBe('LIVE');
  });

  it('quiet hours downgrade to SILENT, in the player time zone, but HIGH priority bypasses', () => {
    const quietHours = { start: '17:00', end: '18:00', timeZone: 'Asia/Kolkata' };
    expect(run('LEVEL_UP', { quietHours }).mode).toBe('SILENT');
    expect(run('PVP_ATTACKED', { quietHours }).mode).toBe('LIVE');
    expect(run('LEVEL_UP', { quietHours: { ...quietHours, timeZone: 'UTC' } }).mode).toBe('LIVE');
  });
});

describe('quiet hours math', () => {
  it('handles windows that wrap midnight', () => {
    expect(inWindow(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(inWindow(6 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(inWindow(7 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(inWindow(12 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(inWindow(12 * 60, 9 * 60, 17 * 60)).toBe(true);
    expect(inWindow(12 * 60, 9 * 60, 9 * 60)).toBe(false);
  });

  it('computes local minutes per IANA zone', () => {
    expect(localMinutes(NOON_UTC, 'UTC')).toBe(12 * 60);
    expect(localMinutes(NOON_UTC, 'Asia/Kolkata')).toBe(17 * 60 + 30);
    expect(isQuietTime({ start: '22:00', end: '07:00', timeZone: 'America/Los_Angeles' }, Date.UTC(2026, 9, 18, 7, 0))).toBe(
      true,
    );
  });
});

describe('PreferenceService (merge patch + optimistic concurrency)', () => {
  const make = () => {
    const clock = new FakeClock(1_000);
    return { svc: new PreferenceService(new InMemoryPreferenceRepository(), clock), clock };
  };

  it('merges patches and bumps the version', () => {
    const { svc } = make();
    const r1 = svc.patch(PlayerId(1), { categories: { SOCIAL: false } });
    expect(r1.ok && r1.value).toMatchObject({ categories: { GAME: true, SOCIAL: false }, version: 1 });
    const r2 = svc.patch(PlayerId(1), { typeOverrides: { NEW_FOLLOWER: true } });
    expect(r2.ok && r2.value).toMatchObject({ categories: { SOCIAL: false }, typeOverrides: { NEW_FOLLOWER: true }, version: 2 });
    const r3 = svc.patch(PlayerId(1), { typeOverrides: { NEW_FOLLOWER: null } });
    expect(r3.ok && r3.value.typeOverrides).toEqual({});
  });

  it('supports mute-for-minutes and quiet hours', () => {
    const { svc } = make();
    const r = svc.patch(PlayerId(1), {
      muteForMinutes: 60,
      quietHours: { start: '22:00', end: '07:00', timeZone: 'Asia/Kolkata' },
    });
    expect(r.ok && r.value.mutedUntil).toBe(1_000 + 3_600_000);
    expect(r.ok && r.value.quietHours?.timeZone).toBe('Asia/Kolkata');
  });

  it('rejects stale versions', () => {
    const { svc } = make();
    svc.patch(PlayerId(1), { categories: { GAME: false } });
    expect(svc.patch(PlayerId(1), { categories: { GAME: true } }, 0)).toEqual({ ok: false, error: { code: 'VERSION_CONFLICT' } });
  });

  it('validates input', () => {
    const { svc } = make();
    expect(svc.patch(PlayerId(1), { categories: { PVP: true } as never }).ok).toBe(false);
    expect(svc.patch(PlayerId(1), { typeOverrides: { NOPE: true } as never }).ok).toBe(false);
    expect(svc.patch(PlayerId(1), { muteForMinutes: -1 }).ok).toBe(false);
    expect(svc.patch(PlayerId(1), { quietHours: { start: '25:00', end: '07:00', timeZone: 'UTC' } }).ok).toBe(false);
    expect(svc.patch(PlayerId(1), { quietHours: { start: '22:00', end: '07:00', timeZone: 'Nowhere/City' } }).ok).toBe(false);
  });
});
