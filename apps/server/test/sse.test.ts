import { afterEach, describe, expect, it } from 'vitest';
import { api, login, openStream, sleep, startApp } from './support.ts';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const setup = async (env: Record<string, string> = {}) => {
  const s = await startApp(env);
  stop = s.stop;
  const internal = (path: string, json: unknown) =>
    api(s.base)(path, { method: 'POST', json, headers: { 'x-internal-key': 'dev-internal-key' } });
  const simulate = (token: string, action: string, args: (number | string)[], repeat = 1) =>
    api(s.base, token)('/v1/dev/simulate', { method: 'POST', json: { action, args, repeat } });
  return { ...s, internal, simulate };
};

describe('GET /v1/stream (SSE gateway)', () => {
  it('rejects unauthenticated clients', async () => {
    const { base } = await setup();
    const r = await fetch(`${base}/v1/stream`);
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
  });

  it('sends hello, then pushes notifications in real time with epoch-seq ids', async () => {
    const { base, app, simulate } = await setup();
    const aria = await login(base, 1);
    const kael = await login(base, 3);
    const s = await openStream(base, aria);
    expect(s.status).toBe(200);
    await s.waitFor((e) => e.some((x) => x.event === 'hello'));
    expect(s.events[0]).toMatchObject({ event: 'hello', id: `${app.core.inbox.epoch}-0`, data: { lastSeq: 0, unread: 0 } });

    await simulate(kael, 'friendRequestSent', [3, 1]);
    await s.waitFor((e) => e.some((x) => x.event === 'notification'));
    const n = s.events.find((x) => x.event === 'notification');
    expect(n?.id).toBe(`${app.core.inbox.epoch}-1`);
    expect(n?.data).toMatchObject({
      seq: 1,
      silent: false,
      notification: { type: 'FRIEND_REQUEST', category: 'SOCIAL', message: "Player 'Kael' has sent you a friend request." },
    });
    s.close();
  });

  it('replays missed notifications from Last-Event-ID, then continues live without gaps or duplicates', async () => {
    const { base, app, simulate } = await setup();
    const aria = await login(base, 1);
    const s1 = await openStream(base, aria);
    await simulate(aria, 'playerLeveledUp', [1, 2]);
    await s1.waitFor((e) => e.some((x) => x.event === 'notification'));
    const lastId = s1.events.filter((x) => x.event === 'notification').at(-1)?.id as string;
    s1.close();
    await sleep(50);

    await simulate(aria, 'playerLeveledUp', [1, 3]); // while offline
    await simulate(aria, 'playerLeveledUp', [1, 4]);
    await app.core.settle();

    const s2 = await openStream(base, aria, lastId);
    await s2.waitFor((e) => e.filter((x) => x.event === 'notification').length === 2);
    await simulate(aria, 'playerLeveledUp', [1, 5]);
    await s2.waitFor((e) => e.filter((x) => x.event === 'notification').length === 3);
    expect(s2.notifications().map((d) => d.seq)).toEqual([2, 3, 4]);
    expect(s2.notifications().map((d) => d.notification.message)).toEqual([
      "Congratulations! You've reached level 3!",
      "Congratulations! You've reached level 4!",
      "Congratulations! You've reached level 5!",
    ]);
    s2.close();
  });

  it('asks the client to resync after a server restart (epoch mismatch)', async () => {
    const { base } = await setup();
    const aria = await login(base, 1);
    const s = await openStream(base, aria, 'deadbeef-7');
    await s.waitFor((e) => e.some((x) => x.event === 'resync'));
    expect(s.events[0]?.data).toMatchObject({ reason: 'restart' });
    s.close();
  });

  it('asks the client to resync when its cursor fell out of retention', async () => {
    const { base, app, simulate } = await setup({ INBOX_CAPACITY: '2' });
    const aria = await login(base, 1);
    await simulate(aria, 'playerLeveledUp', [1, 2], 5);
    await app.core.settle();
    const s = await openStream(base, aria, `${app.core.inbox.epoch}-1`);
    await s.waitFor((e) => e.some((x) => x.event === 'resync'));
    expect(s.events[0]?.data).toMatchObject({ reason: 'evicted', lastSeq: 5 });
    s.close();
  });

  it('muted notifications are not pushed live but are replayed (flagged silent)', async () => {
    const { base, app, simulate } = await setup();
    const aria = await login(base, 1);
    const call = api(base, aria);
    await call('/v1/preferences', { method: 'PATCH', json: { muteForMinutes: 10 } });
    const s = await openStream(base, aria);
    await s.waitFor((e) => e.some((x) => x.event === 'hello'));
    await simulate(aria, 'playerLeveledUp', [1, 7]);
    await app.core.settle();
    await sleep(100);
    expect(s.notifications()).toEqual([]);
    s.close();

    const s2 = await openStream(base, aria, `${app.core.inbox.epoch}-0`);
    await s2.waitFor((e) => e.some((x) => x.event === 'notification'));
    expect(s2.notifications()[0]).toMatchObject({ seq: 1, silent: true });
    s2.close();
  });

  it('fans out to every connected device of the player', async () => {
    const { base, simulate } = await setup();
    const aria = await login(base, 1);
    const [d1, d2] = await Promise.all([openStream(base, aria), openStream(base, aria)]);
    await Promise.all([d1, d2].map((d) => d.waitFor((e) => e.some((x) => x.event === 'hello'))));
    await simulate(aria, 'playerLeveledUp', [1, 9]);
    await Promise.all([d1, d2].map((d) => d.waitFor((e) => e.some((x) => x.event === 'notification'))));
    expect(d1.notifications()[0].notification.id).toBe(d2.notifications()[0].notification.id);
    d1.close();
    d2.close();
  });

  it('sends heartbeats to idle connections', async () => {
    const { base } = await setup({ SSE_HEARTBEAT_MS: '100' });
    const s = await openStream(base, await login(base, 1));
    await sleep(350);
    expect(s.comments.length).toBeGreaterThanOrEqual(1);
    s.close();
  });

  it('caps connections per player (oldest is evicted)', async () => {
    const { base, app } = await setup({ SSE_MAX_CONN_PER_PLAYER: '1' });
    const aria = await login(base, 1);
    const a = await openStream(base, aria);
    await a.waitFor((e) => e.length > 0);
    const b = await openStream(base, aria);
    await b.waitFor((e) => e.length > 0);
    await sleep(50);
    expect(app.registry.size).toBe(1);
    a.close();
    b.close();
  });

  it('replays the current read state, not the state at first serialization', async () => {
    const { base, simulate } = await setup();
    const aria = await login(base, 1);
    const kael = await login(base, 3);
    const live = await openStream(base, aria);
    await live.waitFor((e) => e.some((x) => x.event === 'hello'));
    await simulate(kael, 'friendRequestSent', [3, 1]);
    await live.waitFor((e) => e.some((x) => x.event === 'notification'));
    expect(live.notifications()[0].read).toBe(false);
    const cursor = live.events[0]?.id as string;
    live.close();

    const readAll = await api(base, aria)('/v1/notifications/read-all', { method: 'POST', json: {} });
    expect(readAll.body.marked).toBe(1);
    expect((await api(base, aria)('/v1/notifications')).body.entries[0].read).toBe(true);

    const again = await openStream(base, aria, cursor);
    await again.waitFor((e) => e.some((x) => x.event === 'notification'));
    expect(again.notifications()[0]).toMatchObject({ seq: 1, read: true });
    again.close();
  });
});
