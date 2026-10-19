import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

export interface SseEvent {
  id?: string;
  event: string;
  data: unknown;
}

export const startApp = async (env: Record<string, string> = {}) => {
  const app = await buildApp(loadConfig({ NODE_ENV: 'test', AUTH_SECRET: 'test-secret', ...env }));
  await app.server.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;
  return { app, base, stop: () => app.close() };
};

export const login = async (base: string, playerId: number): Promise<string> => {
  const r = await fetch(`${base}/v1/dev/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId }),
  });
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  return ((await r.json()) as { token: string }).token;
};

export const api =
  (base: string, token?: string) =>
  async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (init.json !== undefined) headers.set('content-type', 'application/json');
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers,
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, headers: res.headers, body: body as any };
  };

/** Minimal spec-compliant SSE client over fetch streaming (same wire format EventSource consumes). */
export const openStream = async (base: string, token: string, lastEventId?: string) => {
  const ac = new AbortController();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'text/event-stream' };
  if (lastEventId) headers['last-event-id'] = lastEventId;
  const res = await fetch(`${base}/v1/stream`, { headers, signal: ac.signal });
  const events: SseEvent[] = [];
  const comments: string[] = [];
  const waiters: { pred: (e: SseEvent[]) => boolean; resolve: () => void }[] = [];
  const check = () => {
    for (const w of [...waiters])
      if (w.pred(events)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
  };
  (async () => {
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev: Partial<SseEvent> & { dataLines: string[] } = { event: 'message', dataLines: [] };
          let isComment = true;
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) {
              comments.push(line);
              continue;
            }
            isComment = false;
            const [k, ...rest] = line.split(':');
            const v = rest.join(':').replace(/^ /, '');
            if (k === 'id') ev.id = v;
            else if (k === 'event') ev.event = v;
            else if (k === 'data') ev.dataLines.push(v);
          }
          if (isComment || ev.dataLines.length === 0) continue;
          const raw = ev.dataLines.join('\n');
          events.push({ ...(ev.id !== undefined ? { id: ev.id } : {}), event: ev.event as string, data: JSON.parse(raw) });
          check();
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    status: res.status,
    events,
    comments,
    notifications: () => events.filter((e) => e.event === 'notification').map((e) => e.data as any),
    waitFor: (pred: (e: SseEvent[]) => boolean, ms = 2_000) =>
      new Promise<void>((resolve, reject) => {
        if (pred(events)) return resolve();
        const t = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(events)}`)), ms);
        waiters.push({
          pred,
          resolve: () => {
            clearTimeout(t);
            resolve();
          },
        });
      }),
    close: () => ac.abort(),
  };
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
