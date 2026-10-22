import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { api, login, startApp, streamTicket } from './support.ts';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
});
const setup = async (env: Record<string, string> = {}) => {
  const s = await startApp(env);
  stop = s.stop;
  return s;
};

describe('auth & health', () => {
  it('health, readiness, metrics', async () => {
    const { base } = await setup();
    const call = api(base);
    expect((await call('/healthz')).body).toEqual({ status: 'ok' });
    expect((await call('/readyz')).body).toMatchObject({ status: 'ready' });
    const m = await call('/metrics');
    expect(m.status).toBe(200);
    expect(m.headers.get('content-type')).toContain('text/plain');
  });

  it('login issues a cookie and a bearer token; /v1/me needs one', async () => {
    const { base } = await setup();
    expect((await api(base)('/v1/me')).status).toBe(401);
    const r = await fetch(`${base}/v1/dev/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 1 }),
    });
    const cookie = r.headers.get('set-cookie') as string;
    expect(cookie).toMatch(/^gid=.+; Path=\/; HttpOnly; SameSite=Lax/);
    const me = await api(base)('/v1/me', { headers: { cookie: cookie.split(';')[0] as string } });
    expect(me.body).toEqual({ playerId: 1, displayName: 'Aria', unread: 0 });
    expect((await api(base, 'forged.token')('/v1/me')).status).toBe(401);
  });

  it('rejects unknown players and bad bodies with problem details', async () => {
    const { base } = await setup();
    const call = api(base);
    expect((await call('/v1/dev/login', { method: 'POST', json: { playerId: 404 } })).status).toBe(404);
    const bad = await call('/v1/dev/login', { method: 'POST', json: { playerId: 'x', extra: 1 } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ type: 'about:blank', title: 'Invalid request', status: 400 });
    expect((await call('/v1/nope')).status).toBe(404);
    expect((await call('/v1/players')).body).toHaveLength(6);
  });

  it('dev endpoints are disabled in production', async () => {
    const { base } = await setup({
      NODE_ENV: 'production',
      AUTH_SECRET: 'prod-test-secret-value',
      INTERNAL_API_KEY: 'prod-test-internal-key',
      LOG_LEVEL: 'silent',
    });
    expect((await api(base)('/v1/dev/login', { method: 'POST', json: { playerId: 1 } })).status).toBe(404);
  });

  it('the 401 detail points at dev login only where that route exists', async () => {
    const dev = await setup();
    expect((await api(dev.base)('/v1/me')).body).toMatchObject({ detail: 'Log in via POST /v1/dev/login' });
    await stop?.();
    const { base } = await setup({
      NODE_ENV: 'production',
      AUTH_SECRET: 'prod-test-secret-value',
      INTERNAL_API_KEY: 'prod-test-internal-key',
      LOG_LEVEL: 'silent',
    });
    const r = await api(base)('/v1/me');
    expect(r.status).toBe(401);
    expect((r.body as { detail: string }).detail).toBe('A session token is required');
  });
});

describe('inbox API', () => {
  it('pages, marks read, marks all read', async () => {
    const { base, app } = await setup();
    const token = await login(base, 1);
    const call = api(base, token);
    for (let lvl = 2; lvl <= 4; lvl++) app.core.gameEngine.playerLeveledUp(1, lvl);
    await app.core.settle();

    const page = await call('/v1/notifications?limit=2');
    expect(page.body).toMatchObject({ epoch: app.core.inbox.epoch, nextBefore: 2, unread: 3 });
    expect(page.body.entries.map((e: { seq: number }) => e.seq)).toEqual([3, 2]);
    const older = await call('/v1/notifications?before=2');
    expect(older.body.entries.map((e: { seq: number }) => e.seq)).toEqual([1]);

    const id = page.body.entries[0].notification.id;
    expect((await call(`/v1/notifications/${id}/read`, { method: 'POST' })).status).toBe(204);
    expect((await call('/v1/notifications/nope/read', { method: 'POST' })).status).toBe(404);
    expect((await call('/v1/notifications/read-all', { method: 'POST', json: {} })).body).toEqual({ marked: 2 });
    expect((await call('/v1/me')).body.unread).toBe(0);
    expect((await call('/v1/notifications?limit=500')).status).toBe(400);
  });
});

describe('preferences API', () => {
  it('merge-patches with ETag / If-Match concurrency control', async () => {
    const { base } = await setup();
    const call = api(base, await login(base, 1));
    const get = await call('/v1/preferences');
    expect(get.headers.get('etag')).toBe('"v0"');
    expect(get.body.categories).toEqual({ GAME: true, SOCIAL: true });

    const patched = await call('/v1/preferences', {
      method: 'PATCH',
      json: { categories: { SOCIAL: false }, typeOverrides: { NEW_FOLLOWER: true } },
      headers: { 'if-match': '"v0"' },
    });
    expect(patched.status).toBe(200);
    expect(patched.headers.get('etag')).toBe('"v1"');
    expect(patched.body).toMatchObject({ categories: { GAME: true, SOCIAL: false }, typeOverrides: { NEW_FOLLOWER: true } });

    const stale = await call('/v1/preferences', {
      method: 'PATCH',
      json: { categories: { GAME: false } },
      headers: { 'if-match': '"v0"' },
    });
    expect(stale.status).toBe(412);

    const mergePatch = await call('/v1/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ categories: { GAME: false } }),
      headers: { 'content-type': 'application/merge-patch+json', 'if-match': '"v1"' },
    });
    expect(mergePatch.status).toBe(200);
    expect(mergePatch.body).toMatchObject({ categories: { GAME: false, SOCIAL: false } });
    const badPatch = await call('/v1/preferences', {
      method: 'PATCH',
      body: '{',
      headers: { 'content-type': 'application/merge-patch+json' },
    });
    expect(badPatch.status).toBe(400);
    expect((await call('/v1/preferences', { method: 'PATCH', json: {}, headers: { 'if-match': 'garbage' } })).status).toBe(400);
  });

  it('validates input', async () => {
    const { base } = await setup();
    const call = api(base, await login(base, 1));
    expect((await call('/v1/preferences', { method: 'PATCH', json: { categories: { PVP: true } } })).status).toBe(400);
    expect((await call('/v1/preferences', { method: 'PATCH', json: { typeOverrides: { NOPE: true } } })).status).toBe(400);
    const tz = await call('/v1/preferences', {
      method: 'PATCH',
      json: { quietHours: { start: '22:00', end: '07:00', timeZone: 'Nowhere/City' } },
    });
    expect(tz.status).toBe(400);
    expect(tz.body.field).toBe('quietHours.timeZone');
    const ok = await call('/v1/preferences', {
      method: 'PATCH',
      json: { quietHours: { start: '22:00', end: '07:00', timeZone: 'Asia/Kolkata' } },
    });
    expect(ok.status).toBe(200);
  });

  it('preferences take effect on the pipeline', async () => {
    const { base, app } = await setup();
    const call = api(base, await login(base, 1));
    await call('/v1/preferences', { method: 'PATCH', json: { categories: { SOCIAL: false } } });
    app.core.socialSystem.friendRequestSent(3, 1);
    app.core.gameEngine.playerLeveledUp(1, 5);
    await app.core.settle();
    const page = await call('/v1/notifications');
    expect(page.body.entries.map((e: { notification: { type: string } }) => e.notification.type)).toEqual(['LEVEL_UP']);
  });
});

describe('POST /v1/events (ingestion for real producers)', () => {
  const key = { 'x-internal-key': 'dev-internal-key' };

  it('accepts valid events and dispatches them', async () => {
    const { base, app } = await setup();
    const r = await api(base)('/v1/events', {
      method: 'POST',
      headers: key,
      json: { kind: 'game.item_acquired', eventId: 'ext-1', playerId: 2, itemId: 'SwordOfAzeroth' },
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ accepted: true, eventId: 'ext-1' });
    await app.core.settle();
    expect(app.core.inboxService.page(2 as never, null, 1).entries[0]?.notification.message).toBe(
      "You've acquired the legendary Sword of Azeroth!",
    );
  });

  it('requires the internal key and a valid schema', async () => {
    const { base } = await setup();
    const call = api(base);
    expect(
      (await call('/v1/events', { method: 'POST', json: { kind: 'game.player_leveled_up', playerId: 1, newLevel: 2 } })).status,
    ).toBe(401);
    expect((await call('/v1/events', { method: 'POST', headers: key, json: { kind: 'game.unknown', playerId: 1 } })).status).toBe(
      400,
    );
    expect(
      (await call('/v1/events', { method: 'POST', headers: key, json: { kind: 'game.player_leveled_up', playerId: 1 } })).status,
    ).toBe(400);
  });

  it('answers an unknown or missing kind with one clear 400', async () => {
    const { base } = await setup();
    const post = (json: unknown) => api(base)('/v1/events', { method: 'POST', headers: key, json });
    const unknown = await post({ kind: 'Foo', playerId: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ title: 'Invalid request' });
    const detail = (unknown.body as { detail: string }).detail;
    expect(detail).toMatch(/unknown event kind "Foo"; expected one of: game\.player_leveled_up, /);
    expect(detail).not.toMatch(/must match|oneOf|const/);
    const missing = await post({ playerId: 1 });
    expect(missing.status).toBe(400);
    expect((missing.body as { detail: string }).detail).toMatch(/missing event kind; expected one of: /);
    const bad = await post({ kind: 'game.player_leveled_up', playerId: 1 });
    expect(bad.status).toBe(400);
    expect((bad.body as { detail: string }).detail).toMatch(/newLevel/);
  });

  it('reports only the missing field for a known kind with a bad body', async () => {
    const { base } = await setup();
    const r = await api(base)('/v1/events', {
      method: 'POST',
      headers: key,
      json: { kind: 'game.player_leveled_up', playerId: 1 },
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ title: 'Invalid request', detail: "body must have required property 'newLevel'" });
    expect((r.body as { detail: string }).detail).not.toMatch(/oneOf|must match|itemId|attackerId/);
  });

  it('reports only the extra field for a known kind with an unexpected property', async () => {
    const { base } = await setup();
    const r = await api(base)('/v1/events', {
      method: 'POST',
      headers: key,
      json: { kind: 'game.player_leveled_up', playerId: 1, newLevel: 2, extra: true },
    });
    expect(r.status).toBe(400);
    expect((r.body as { detail: string }).detail).toBe("body must NOT have additional property 'extra'");
  });

  it('returns 503 + Retry-After when the bus is full', async () => {
    const { base, app } = await setup({ BUS_CAPACITY: '2' });
    // Stall the consumer so the queue fills up deterministically.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.core.bus.subscribeAll(() => gate);
    const body = { kind: 'game.player_leveled_up', playerId: 1, newLevel: 2 };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await api(base)('/v1/events', { method: 'POST', headers: key, json: body });
      statuses.push(r.status);
      if (r.status === 503) expect(r.headers.get('retry-after')).toBe('1');
    }
    expect(statuses).toContain(503);
    expect(statuses[0]).toBe(202);
    release();
  });
});

describe('POST /v1/dev/simulate', () => {
  it('drives the brief API and validates arguments', async () => {
    const { base } = await setup();
    const call = api(base, await login(base, 1));
    const ok = await call('/v1/dev/simulate', { method: 'POST', json: { action: 'playerLeveledUp', args: [1, 15] } });
    expect(ok.status).toBe(202);
    expect(ok.body.results).toEqual(['accepted']);
    for (const [action, args] of [
      ['itemAcquired', [2, 'SwordOfAzeroth']],
      ['challengeCompleted', [6, 'DragonsLair']],
      ['playerAttacked', [5, 6]],
      ['playerDefeated', [5, 4]],
      ['friendRequestSent', [3, 1]],
      ['friendRequestAccepted', [1, 3]],
      ['playerFollowed', [2, 1]],
    ] as const) {
      expect((await call('/v1/dev/simulate', { method: 'POST', json: { action, args } })).status).toBe(202);
    }
    expect((await call('/v1/dev/simulate', { method: 'POST', json: { action: 'playerLeveledUp', args: [1, 'x'] } })).status).toBe(
      400,
    );
    expect((await call('/v1/dev/simulate', { method: 'POST', json: { action: 'hack', args: [1, 2] } })).status).toBe(400);
  });
});

describe('gates run before validation', () => {
  const prod = {
    NODE_ENV: 'production',
    AUTH_SECRET: 'prod-test-secret-value',
    INTERNAL_API_KEY: 'prod-test-internal-key',
    LOG_LEVEL: 'silent',
  };

  it('POST /v1/events answers 401 before 400 when the internal key is missing or wrong', async () => {
    const { base } = await setup();
    const call = api(base);
    for (const json of [{ kind: 'nope' }, {}, { kind: 'game.player_leveled_up', playerId: 1 }]) {
      const r = await call('/v1/events', { method: 'POST', json });
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ title: 'Unauthorized' });
      expect((await call('/v1/events', { method: 'POST', json, headers: { 'x-internal-key': 'wrong' } })).status).toBe(401);
    }
  });

  it('dev routes answer 404 in production even for an invalid body', async () => {
    const { base } = await setup(prod);
    const call = api(base);
    expect((await call('/v1/dev/login', { method: 'POST', json: { playerId: 'x', extra: 1 } })).status).toBe(404);
    expect((await call('/v1/dev/login', { method: 'POST', json: {} })).status).toBe(404);
    expect((await call('/v1/dev/simulate', { method: 'POST', json: { action: 'hack' } })).status).toBe(404);
    expect((await call('/v1/dev/simulate', { method: 'POST', json: { action: 'itemAcquired', args: [1, '__'] } })).status).toBe(
      404,
    );
  });
});

describe('item ids need a letter or digit', () => {
  it('POST /v1/events rejects blank item and challenge ids with a clear 400', async () => {
    const { base } = await setup();
    const key = { 'x-internal-key': 'dev-internal-key' };
    for (const itemId of ['__', '   ', '-.-']) {
      const r = await api(base)('/v1/events', {
        method: 'POST',
        headers: key,
        json: { kind: 'game.item_acquired', playerId: 1, itemId },
      });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ title: 'Invalid request', detail: 'itemId must contain at least one letter or digit' });
    }
    const ok = await api(base)('/v1/events', {
      method: 'POST',
      headers: key,
      json: { kind: 'game.item_acquired', playerId: 1, itemId: 'Sword_Of_Azeroth' },
    });
    expect(ok.status).toBe(202);
  });

  it('POST /v1/dev/simulate rejects blank item ids with a clear 400', async () => {
    const { base } = await setup();
    const call = api(base, await login(base, 1));
    for (const id of ['__', '   ']) {
      const r = await call('/v1/dev/simulate', { method: 'POST', json: { action: 'itemAcquired', args: [1, id] } });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ title: 'Invalid request', detail: 'args[1] must contain at least one letter or digit' });
    }
  });
});

describe('POST /v1/dev/logout', () => {
  it('clears the session cookie and answers 204, with or without a session', async () => {
    const { base } = await setup();
    for (const token of [undefined, await login(base, 1)]) {
      const r = await api(base, token)('/v1/dev/logout', { method: 'POST' });
      expect(r.status).toBe(204);
      expect(r.headers.get('set-cookie')).toBe('gid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    }
  });

  it('a cleared cookie no longer authenticates', async () => {
    const { base } = await setup();
    const r = await fetch(`${base}/v1/dev/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 1 }),
    });
    const gid = (r.headers.get('set-cookie') as string).split(';')[0] as string;
    expect((await api(base)('/v1/me', { headers: { cookie: gid } })).status).toBe(200);
    const out = await api(base)('/v1/dev/logout', { method: 'POST', headers: { cookie: gid } });
    const cleared = (out.headers.get('set-cookie') as string).split(';')[0] as string;
    expect(cleared).toBe('gid=');
    expect((await api(base)('/v1/me', { headers: { cookie: cleared } })).status).toBe(401);
  });
});

describe('POST /v1/stream/ticket when the store is full', () => {
  it('answers 503 with Retry-After instead of issuing a ticket', async () => {
    const s = await startApp({}, { maxStreamTickets: 1 });
    stop = s.stop;
    const one = api(s.base, await login(s.base, 1));
    const two = api(s.base, await login(s.base, 2));
    expect((await one('/v1/stream/ticket', { method: 'POST' })).status).toBe(200);
    const full = await two('/v1/stream/ticket', { method: 'POST' });
    expect(full.status).toBe(503);
    expect(full.headers.get('retry-after')).toBe('1');
    expect(full.body).toMatchObject({ title: 'Too many pending stream tickets' });
    expect(full.body.ticket).toBeUndefined();
  });
});

describe('graceful shutdown', () => {
  it('never acknowledges an event it will not deliver: ingest is refused once shutdown starts', async () => {
    const { base, app, stop: close } = await setup();
    stop = undefined;

    // Hold shutdown open right after the core has drained, i.e. in the window where HTTP used to still accept.
    let coreDrained!: () => void;
    const drained = new Promise<void>((r) => {
      coreDrained = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const shutdown = app.core.shutdown.bind(app.core);
    app.core.shutdown = async () => {
      await shutdown();
      coreDrained();
      await gate;
    };

    const closing = close();
    await drained;
    const r = await api(base)('/v1/events', {
      method: 'POST',
      headers: { 'x-internal-key': 'dev-internal-key' },
      json: { kind: 'game.player_leveled_up', eventId: 'late-1', playerId: 1, newLevel: 7 },
    });
    release();
    await closing;

    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('1');
    expect(app.core.inboxService.page(1 as never, null, 10).entries).toHaveLength(0);
  });
});

describe('operational hardening', () => {
  const key = { 'x-internal-key': 'dev-internal-key' };

  it('compares the internal key exactly: wrong, wrong-length, empty and missing keys are refused', async () => {
    const { base } = await setup();
    const call = (headers: Record<string, string>) =>
      api(base)('/v1/events', { method: 'POST', headers, json: { kind: 'game.player_leveled_up', playerId: 1, newLevel: 2 } });
    expect((await call({})).status).toBe(401);
    expect((await call({ 'x-internal-key': '' })).status).toBe(401);
    expect((await call({ 'x-internal-key': 'dev-internal-kez' })).status).toBe(401);
    expect((await call({ 'x-internal-key': 'dev-internal-key-and-more' })).status).toBe(401);
    expect((await call({ 'x-internal-key': 'x' })).status).toBe(401);
    expect((await call(key)).status).toBe(202);
  });

  it('rejects events for players that are not in the directory (422) before publishing', async () => {
    const { base, app } = await setup();
    const before = app.core.bus.depth;
    const call = (json: unknown) => api(base)('/v1/events', { method: 'POST', headers: key, json });
    const r = await call({ kind: 'game.player_leveled_up', playerId: 9_007_199_254_740_991, newLevel: 2 });
    expect(r.status).toBe(422);
    expect(r.headers.get('content-type')).toContain('application/problem+json');
    // Known actor, unknown target.
    expect((await call({ kind: 'social.friend_request_sent', senderId: 1, recipientId: 424_242 })).status).toBe(422);
    expect((await call({ kind: 'game.pvp_attacked', attackerId: 555_555, victimId: 1 })).status).toBe(422);
    expect(app.core.bus.depth).toBe(before);
    await app.core.settle();
    expect(app.core.inbox.lastSeq(424_242 as never)).toBe(0);
    expect((await call({ kind: 'social.friend_request_sent', senderId: 3, recipientId: 1 })).status).toBe(202);
  });

  it('dev simulate rejects unknown players with 422', async () => {
    const { base } = await setup();
    const call = api(base, await login(base, 1));
    const r = await call('/v1/dev/simulate', { method: 'POST', json: { action: 'playerFollowed', args: [2, 999_999] } });
    expect(r.status).toBe(422);
    expect(
      (await call('/v1/dev/simulate', { method: 'POST', json: { action: 'playerLeveledUp', args: [999_999, 3] } })).status,
    ).toBe(422);
  });

  it('dev simulate returns 503 + Retry-After when the bus rejects the event', async () => {
    const { base, app } = await setup({ BUS_CAPACITY: '2' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.core.bus.subscribeAll(() => gate);
    const call = api(base, await login(base, 1));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call('/v1/dev/simulate', { method: 'POST', json: { action: 'playerLeveledUp', args: [1, 2] } });
      statuses.push(r.status);
      if (r.status === 503) expect(r.headers.get('retry-after')).toBe('1');
    }
    expect(statuses[0]).toBe(202);
    expect(statuses).toContain(503);
    release();
  });
});

describe('request logging', () => {
  it('never writes session tokens from the query string to the logs', async () => {
    const lines: string[] = [];
    const logStream = {
      write: (l: string) => {
        lines.push(l);
      },
    };
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', AUTH_SECRET: 'test-secret', LOG_LEVEL: 'info' }), { logStream });
    await app.server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
    try {
      const token = await login(base, 1);
      const ac = new AbortController();
      const ticket = await streamTicket(base, token);
      const ok = await fetch(`${base}/v1/stream?ticket=${ticket}&lastEventId=x`, { signal: ac.signal });
      expect(ok.status).toBe(200);
      ac.abort();
      // A bad token takes the error path (request completed with 401).
      const bad = await fetch(`${base}/v1/stream?token=bad.secret-token-value`);
      expect(bad.status).toBe(401);
      const badTicket = await fetch(`${base}/v1/stream?ticket=bad-secret-ticket-value`);
      expect(badTicket.status).toBe(401);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await app.close();
    }
    const all = lines.join('');
    expect(all).toContain('/v1/stream');
    expect(all).not.toContain('secret-token-value');
    expect(all).not.toContain('secret-ticket-value');
    expect(all).not.toMatch(/token=(?!\[redacted\])/);
    expect(all).not.toMatch(/ticket=(?!\[redacted\])/);
    expect(all).toContain('token=[redacted]');
    expect(all).toContain('ticket=[redacted]');
    expect(all).toContain('lastEventId=x');
  });
});
