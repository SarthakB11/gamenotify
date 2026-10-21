import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { PlayerId } from '@gamenotify/core';
import { describe, expect, it } from 'vitest';
import { DevAuthenticator, readCookie } from '../src/auth/dev-auth.ts';
import { StreamTicketStore } from '../src/auth/stream-tickets.ts';
import { loadConfig } from '../src/config.ts';
import { controlFrame, parseCursor } from '../src/sse/frame.ts';
import { SseConnection } from '../src/sse/sse-connection.ts';

class FakeRes extends EventEmitter {
  writableNeedDrain = false;
  writableEnded = false;
  chunks: string[] = [];
  write(c: string) {
    this.chunks.push(c);
    return true;
  }
  cork() {}
  uncork() {}
  end() {
    this.writableEnded = true;
  }
}

const conn = (res: FakeRes, maxQueued = 2, evictions: string[] = []) =>
  new SseConnection({
    playerId: PlayerId(1),
    res: res as unknown as ServerResponse,
    maxQueued,
    now: () => 0,
    onEvict: (_c, r) => evictions.push(r),
  });

describe('SseConnection', () => {
  it('buffers during the handshake and de-duplicates against replay on goLive', () => {
    const res = new FakeRes();
    const c = conn(res);
    c.deliver(3, 'f3');
    c.deliver(2, 'f2');
    c.write('replay-1;');
    c.write('replay-2;');
    c.lastSeq = 2; // replay covered up to seq 2
    c.goLive();
    expect(res.chunks).toEqual(['replay-1;', 'replay-2;', 'f3']);
    c.deliver(3, 'f3-again');
    c.deliver(4, 'f4');
    expect(res.chunks.at(-1)).toBe('f4');
    expect(c.state).toBe('LIVE');
  });

  it('queues under back-pressure, flushes on drain, evicts slow consumers', () => {
    const res = new FakeRes();
    const evictions: string[] = [];
    const c = conn(res, 2, evictions);
    c.goLive();
    res.writableNeedDrain = true;
    c.deliver(1, 'a');
    c.deliver(2, 'b');
    expect(c.queued).toBe(2);
    res.writableNeedDrain = false;
    res.emit('drain');
    expect(res.chunks).toEqual(['a', 'b']);
    res.writableNeedDrain = true;
    c.deliver(3, 'c');
    c.deliver(4, 'd');
    c.deliver(5, 'e'); // over the cap
    expect(evictions).toEqual(['slow_consumer']);
    expect(c.state).toBe('CLOSED');
    expect(res.writableEnded).toBe(true);
    c.deliver(6, 'f');
    c.write('g');
    expect(res.chunks).toEqual(['a', 'b']);
  });
});

describe('frames & cursors', () => {
  it('parses epoch-seq cursors', () => {
    expect(parseCursor('ab12cd34-42')).toEqual({ epoch: 'ab12cd34', seq: 42 });
    expect(parseCursor('nodash')).toBeNull();
    expect(parseCursor('x--1')).toBeNull();
    expect(parseCursor(undefined)).toBeNull();
  });
  it('formats control frames', () => {
    expect(controlFrame('hello', { a: 1 }, 'e-0')).toBe('id: e-0\nevent: hello\ndata: {"a":1}\n\n');
    expect(controlFrame('x', 1)).toBe('event: x\ndata: 1\n\n');
  });
});

describe('DevAuthenticator', () => {
  it('round-trips, rejects tampering and expiry', () => {
    let now = 0;
    const a = new DevAuthenticator('s', () => now);
    const t = a.issue(PlayerId(7));
    expect(a.verify(t)).toBe(7);
    expect(a.verify(`${t}x`)).toBeNull();
    expect(new DevAuthenticator('other', () => now).verify(t)).toBeNull();
    expect(a.verify('garbage')).toBeNull();
    expect(a.verify(undefined)).toBeNull();
    now = 13 * 3600 * 1000;
    expect(a.verify(t)).toBeNull();
    expect(a.cookie('tok', true)).toContain('Secure');
  });
  it('rejects tokens with extra dot-separated segments', () => {
    const a = new DevAuthenticator('s', () => 0);
    const t = a.issue(PlayerId(7));
    expect(a.verify(`${t}.junk`)).toBeNull();
    expect(a.verify(`${t}.`)).toBeNull();
  });
  it('reads cookies', () => {
    expect(readCookie('a=1; gid=xyz; b=2', 'gid')).toBe('xyz');
    expect(readCookie(undefined, 'gid')).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('applies defaults and env overrides', () => {
    const c = loadConfig({ NODE_ENV: 'test', PORT: '8080', GROUP_WINDOW_MS: '1500', MIN_ITEM_RARITY: 'epic' });
    expect(c.port).toBe(8080);
    expect(c.core.grouping?.windowMs).toBe(1500);
    expect(c.core.minItemRarity).toBe(3);
    expect(c.authSecretGenerated).toBe(true);
  });
  it('fails fast on invalid values and missing production secrets', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/AUTH_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_SECRET: 'x' })).toThrow(/INTERNAL_API_KEY/);
  });

  it('refuses dev-default or weak secrets in production', () => {
    const ok = {
      NODE_ENV: 'production',
      AUTH_SECRET: 'a-long-random-secret-value',
      INTERNAL_API_KEY: 'a-long-random-internal-key',
    };
    expect(loadConfig(ok).env).toBe('production');
    expect(() => loadConfig({ ...ok, INTERNAL_API_KEY: 'dev-internal-key' })).toThrow(/INTERNAL_API_KEY.*default/);
    expect(() => loadConfig({ ...ok, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET.*at least/);
    expect(() => loadConfig({ ...ok, INTERNAL_API_KEY: 'short' })).toThrow(/INTERNAL_API_KEY.*at least/);
    // Development keeps the convenient defaults.
    expect(loadConfig({ NODE_ENV: 'development' }).internalApiKey).toBe('dev-internal-key');
  });
});

describe('StreamTicketStore', () => {
  it('is single-use, expires and stays bounded', () => {
    let now = 0;
    const store = new StreamTicketStore(1_000, 3, () => now);
    const p = PlayerId(1);
    const t = store.issue(p) as string;
    expect(store.consume(t)).toBe(p);
    expect(store.consume(t)).toBeNull();
    expect(store.size).toBe(0);

    const a = store.issue(p) as string;
    store.issue(p);
    store.issue(p);
    expect(store.issue(p)).toBeNull(); // full of live tickets
    now = 1_001;
    expect(store.consume(a)).toBeNull(); // expired
    expect(store.issue(p)).not.toBeNull();
    expect(store.issue(p)).not.toBeNull();
    expect(store.issue(p)).not.toBeNull(); // the full map was swept of expired tickets
    expect(store.size).toBe(3);
    expect(store.issue(p)).toBeNull();
  });

  it('caps live tickets per player by evicting the oldest, so one player cannot exhaust the store', () => {
    const store = new StreamTicketStore(30_000, 20, () => 0, 3);
    const greedy = PlayerId(1);
    const minted = Array.from({ length: 1_000 }, () => store.issue(greedy) as string);
    expect(store.size).toBe(3);
    expect(store.consume(minted[0] as string)).toBeNull(); // evicted
    expect(store.consume(minted[996] as string)).toBeNull();
    expect(store.consume(minted[999] as string)).toBe(greedy); // the newest still works (reconnect)
    expect(store.size).toBe(2);

    for (let n = 2; n <= 18; n++) expect(store.issue(PlayerId(n))).not.toBeNull(); // others are unaffected
    expect(store.issue(PlayerId(99))).not.toBeNull();
  });
});
