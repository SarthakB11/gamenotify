/**
 * SSE fan-out load test (NFR-3). Starts the server in a child process, opens N EventSource-equivalent
 * connections (one per synthetic player), publishes events at a fixed rate through POST /v1/events,
 * and reports end-to-end latency (event accepted → frame parsed by the client) and server RSS.
 *
 *   pnpm build && pnpm load:sse                      # defaults: 2,000 connections, 1,000 events/s, 10 s
 *   CONNECTIONS=10000 RATE=2000 pnpm load:sse        # raise `ulimit -n` first
 */
import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import { join } from 'node:path';

const CONNECTIONS = Number(process.env.CONNECTIONS ?? 2_000);
const RATE = Number(process.env.RATE ?? 1_000);
const DURATION_S = Number(process.env.DURATION_S ?? 10);
const PORT = Number(process.env.LOAD_PORT ?? 3999);
const KEY = 'load-key';
const root = join(import.meta.dirname, '..');
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const startServer = (): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'apps/server/dist/main.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        LOG_LEVEL: 'warn',
        NODE_ENV: 'development',
        INTERNAL_API_KEY: KEY,
        SYNTHETIC_PLAYERS: String(CONNECTIONS),
        RATE_CAPACITY: '1000000',
        SSE_HEARTBEAT_MS: '15000',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    const poll = setInterval(() => {
      http
        .get(`http://127.0.0.1:${PORT}/healthz`, (r) => {
          r.resume();
          if (r.statusCode === 200) {
            clearInterval(poll);
            resolve(child);
          }
        })
        .on('error', () => {});
    }, 100);
  });

const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        agent,
        headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });

const latencies: number[] = [];
let received = 0;

const openStream = (token: string) =>
  new Promise<void>((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/v1/stream', headers: { authorization: `Bearer ${token}` }, agent: false },
      (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!frame.includes('event: notification')) continue;
            const m = /"level":(\d+)/.exec(frame); // level carries the send timestamp offset (see publisher)
            received++;
            if (m) latencies.push(Date.now() - (t0 + Number(m[1])));
          }
        });
        resolve();
      },
    );
    req.on('error', reject);
  });

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

let t0 = 0;
const server = await startServer();
try {
  console.log(`opening ${CONNECTIONS.toLocaleString()} SSE connections…`);
  const ids = Array.from({ length: CONNECTIONS }, (_, i) => 1001 + i);
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const tokens = await Promise.all(
      batch.map(
        async (id) => (JSON.parse((await request('POST', '/v1/dev/login', { playerId: id })).body) as { token: string }).token,
      ),
    );
    await Promise.all(tokens.map(openStream));
  }
  console.log(`publishing ${RATE.toLocaleString()} events/s for ${DURATION_S}s…`);
  t0 = Date.now();
  let sent = 0;
  const tickMs = 50;
  const perTick = Math.max(1, Math.round((RATE * tickMs) / 1000));
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - t0;
      if (elapsed >= DURATION_S * 1000) {
        clearInterval(timer);
        resolve();
        return;
      }
      for (let k = 0; k < perTick; k++) {
        const playerId = ids[(sent + k) % ids.length] as number;
        // newLevel = ms since t0 → the client computes latency from it without clock-sync issues.
        void request(
          'POST',
          '/v1/events',
          { kind: 'game.player_leveled_up', playerId, newLevel: Math.max(1, Date.now() - t0) },
          { 'x-internal-key': KEY },
        );
      }
      sent += perTick;
    }, tickMs);
  });
  await new Promise((r) => setTimeout(r, 1_000));
  const ready = JSON.parse((await request('GET', '/readyz')).body) as { connections: number };
  const metrics = (await request('GET', '/metrics')).body;
  const rss = Number(/process_resident_memory_bytes (\d+)/.exec(metrics)?.[1] ?? 0) / 1024 / 1024;
  console.log(`\nconnections open: ${ready.connections.toLocaleString()}`);
  console.log(`events sent: ${sent.toLocaleString()} · notifications received: ${received.toLocaleString()}`);
  console.log(`end-to-end latency  p50 ${pct(latencies, 50)} ms · p99 ${pct(latencies, 99)} ms · max ${pct(latencies, 100)} ms`);
  console.log(`server RSS: ${rss.toFixed(0)} MB`);
} finally {
  server.kill('SIGTERM');
  agent.destroy();
  setTimeout(() => process.exit(0), 500).unref();
}
