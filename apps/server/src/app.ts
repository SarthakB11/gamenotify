import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import {
  buildCore,
  type Core,
  EventId,
  InMemoryPlayerDirectory,
  type NotificationId,
  type PlatformEvent,
  PlayerId,
  type PreferencesPatch,
  SEED,
  systemClock,
  toInboxEntryDto,
} from '@gamenotify/core';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { DevAuthenticator } from './auth/dev-auth.ts';
import { StreamTicketStore } from './auth/stream-tickets.ts';
import type { ServerConfig } from './config.ts';
import { problem } from './http/problem.ts';
import {
  idParams,
  loginBody,
  pageQuery,
  platformEventBody,
  preferencesPatch,
  readAllBody,
  type SimulateAction,
  simulateBody,
} from './http/schemas.ts';
import { PromMetrics, pinoAdapter } from './observability/adapters.ts';
import { ConnectionRegistry, SseNotificationSender } from './sse/connection-registry.ts';
import { controlFrame, cursorId, notificationFrame, parseCursor } from './sse/frame.ts';
import { SseConnection } from './sse/sse-connection.ts';

export interface App {
  readonly server: FastifyInstance;
  readonly core: Core;
  readonly registry: ConnectionRegistry;
  readonly metricsRegistry: Registry;
  /** Graceful shutdown: readiness off → refuse ingest → drain core → close streams → stop HTTP. */
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    playerId: PlayerId | null;
  }
}

export interface AppOptions {
  /** Where log lines go (default: stdout). Tests capture it to assert on what is logged. */
  readonly logStream?: { write(line: string): void };
  /** Stream ticket lifetime (default 30 s). */
  readonly streamTicketTtlMs?: number;
  /** Clock for ticket expiry (default `Date.now`). */
  readonly now?: () => number;
}

/** Stream tickets ride in `?ticket=` (EventSource cannot set headers), and a stray `?token=` must not leak either; never log them. */
export const redactUrl = (url: string): string => url.replace(/([?&](?:token|ticket)=)[^&#]*/gi, '$1[redacted]');

/** Constant-time string equality: hash both sides so unequal lengths neither throw nor leak. */
const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Every player id an ingested event refers to (actors and targets). */
const PLAYER_FIELDS = [
  'playerId',
  'attackerId',
  'victimId',
  'winnerId',
  'loserId',
  'senderId',
  'recipientId',
  'accepterId',
  'requesterId',
  'followerId',
  'followeeId',
] as const;

export async function buildApp(config: ServerConfig, options: AppOptions = {}): Promise<App> {
  const server = Fastify({
    logger: {
      level: config.logLevel,
      ...(options.logStream ? { stream: options.logStream } : {}),
      serializers: {
        req: (req: FastifyRequest) => ({
          method: req.method,
          url: redactUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
          ...(req.socket?.remotePort !== undefined ? { remotePort: req.socket.remotePort } : {}),
        }),
      },
    },
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: 'array',
        useDefaults: true,
        allErrors: false,
        allowUnionTypes: true,
      },
    },
    return503OnClosing: true,
  });

  const metricsRegistry = new Registry();
  if (config.env !== 'test') collectDefaultMetrics({ register: metricsRegistry });
  const metrics = new PromMetrics(metricsRegistry);
  const logger = pinoAdapter(server.log);
  if (config.authSecretGenerated) logger.warn({}, 'AUTH_SECRET not set: generated an ephemeral dev secret');

  const epoch = randomUUID().slice(0, 8);
  const registry = new ConnectionRegistry(config.sse.maxConnectionsPerPlayer, metrics);
  const directory = new InMemoryPlayerDirectory([
    ...SEED.players,
    ...Array.from({ length: config.syntheticPlayers }, (_, i) => ({ id: PlayerId(1001 + i), displayName: `Bot${1001 + i}` })),
  ]);
  const core = buildCore(
    { sender: new SseNotificationSender(registry, epoch), logger, metrics, inboxEpoch: epoch, directory },
    config.core,
  );
  const auth = new DevAuthenticator(config.authSecret, options.now);
  const tickets = new StreamTicketStore(options.streamTicketTtlMs, undefined, options.now);
  let ready = true;
  /** Set first thing on shutdown: from then on ingest is refused, so nothing is acknowledged after the core stops. */
  let closing = false;

  // ── Cross-cutting hooks ────────────────────────────────────────────────────
  server.decorateRequest('playerId', null);
  server.addHook('onRequest', async (req) => {
    req.playerId = auth.authenticate(req);
  });
  server.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    );
    return payload;
  });
  server.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error.validation) return problem(reply, 400, 'Invalid request', error.message);
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    if (status >= 500) server.log.error({ err: error }, 'unhandled error');
    return problem(reply, status, status >= 500 ? 'Internal Server Error' : error.message);
  });

  const requirePlayer = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.playerId === null) return problem(reply, 401, 'Unauthorized', 'Log in via POST /v1/dev/login');
  };
  /** `?ticket=` (browser) is consumed here and wins over any header; otherwise Bearer/cookie as for any route. */
  const requireStreamAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const ticket = (req.query as { ticket?: unknown }).ticket;
    if (ticket !== undefined) {
      req.playerId = typeof ticket === 'string' ? tickets.consume(ticket) : null;
      if (req.playerId === null) return problem(reply, 401, 'Unauthorized', 'Stream ticket is invalid, expired or already used');
      return;
    }
    return requirePlayer(req, reply);
  };
  const requireInternalKey = async (req: FastifyRequest, reply: FastifyReply) => {
    const given = req.headers['x-internal-key'];
    if (!config.internalApiKey || typeof given !== 'string' || !safeEqual(given, config.internalApiKey)) {
      return problem(reply, 401, 'Unauthorized', 'Missing or invalid x-internal-key');
    }
  };
  const refuseWhenClosing = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (closing) {
      reply.header('Retry-After', '1');
      return problem(reply, 503, 'Shutting down');
    }
  };
  /** Unbounded inbox logs are created per recipient, so only known players may be referenced. */
  const unknownPlayer = (body: Record<string, unknown>): unknown =>
    PLAYER_FIELDS.map((f) => body[f]).find((id) => id !== undefined && !core.directory.get(id as PlayerId));
  const devOnly = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (config.env === 'production') return problem(reply, 404, 'Not Found');
  };

  // ── Health & metrics ───────────────────────────────────────────────────────
  server.get('/healthz', async () => ({ status: 'ok' }));
  server.get('/readyz', async (_req, reply) =>
    ready ? { status: 'ready', connections: registry.size, busDepth: core.bus.depth } : problem(reply, 503, 'Draining'),
  );
  server.get('/metrics', async (_req, reply) => reply.type(metricsRegistry.contentType).send(await metricsRegistry.metrics()));

  // ── Dev auth & players ─────────────────────────────────────────────────────
  server.get('/v1/players', async () => SEED.players.map((p) => ({ id: p.id, displayName: p.displayName })));

  server.post<{ Body: { playerId: number } }>(
    '/v1/dev/login',
    { schema: { body: loginBody }, preHandler: devOnly },
    async (req, reply) => {
      const id = PlayerId(req.body.playerId);
      const profile = core.directory.get(id);
      if (!profile) return problem(reply, 404, 'Unknown player');
      const token = auth.issue(id);
      reply.header('Set-Cookie', auth.cookie(token, req.protocol === 'https'));
      return { playerId: id, displayName: profile.displayName, token };
    },
  );

  server.post('/v1/dev/logout', async (_req, reply) => {
    reply.header('Set-Cookie', 'gid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return reply.code(204).send();
  });

  server.get('/v1/me', { preHandler: requirePlayer }, async (req) => {
    const id = req.playerId as PlayerId;
    return { playerId: id, displayName: core.directory.get(id)?.displayName ?? `#${id}`, unread: core.inboxService.unread(id) };
  });

  // ── Real-time stream (SSE) ─────────────────────────────────────────────────
  server.post('/v1/stream/ticket', { preHandler: requirePlayer }, async (req, reply) => {
    const ticket = tickets.issue(req.playerId as PlayerId);
    if (ticket === null) {
      reply.header('Retry-After', '1');
      return problem(reply, 503, 'Too many pending stream tickets');
    }
    reply.header('Cache-Control', 'no-store');
    return { ticket, expiresInMs: tickets.ttlMs };
  });

  server.get<{ Querystring: { lastEventId?: string; ticket?: string } }>(
    '/v1/stream',
    { preHandler: requireStreamAuth },
    (req, reply) => {
      const player = req.playerId as PlayerId;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      });
      res.socket?.setNoDelay(true);
      res.socket?.setKeepAlive(true, 30_000);

      const conn = new SseConnection({
        playerId: player,
        res,
        maxQueued: config.sse.maxBufferedFrames,
        now: systemClock.now,
        onEvict: (c, reason) => {
          metrics.inc('sse_evictions_total', { reason });
          logger.warn({ playerId: c.playerId, connId: c.id, reason }, 'sse connection evicted');
        },
      });
      // 1) register first (live frames are buffered), 2) replay, 3) go live — no gap, no duplicates.
      registry.add(conn);
      conn.write(`retry: ${config.sse.retryMs}\n\n`);

      const inbox = core.inbox;
      const lastSeq = inbox.lastSeq(player);
      const cursor = parseCursor(req.headers['last-event-id'] ?? req.query.lastEventId);
      const resync = (reason: string) => {
        metrics.inc('sse_resync_total', { reason });
        conn.write(controlFrame('resync', { reason, epoch: inbox.epoch, lastSeq }, cursorId(inbox.epoch, lastSeq)));
        conn.lastSeq = lastSeq;
      };

      if (cursor === null) {
        conn.write(
          controlFrame(
            'hello',
            { epoch: inbox.epoch, lastSeq, unread: inbox.unreadCount(player) },
            cursorId(inbox.epoch, lastSeq),
          ),
        );
        conn.lastSeq = lastSeq;
      } else if (cursor.epoch !== inbox.epoch) {
        resync('restart');
      } else {
        const r = inbox.since(player, cursor.seq, config.sse.replayLimit);
        if (r.kind === 'resync') resync('evicted');
        else if (r.entries.length === config.sse.replayLimit && (r.entries.at(-1)?.seq ?? 0) < lastSeq) resync('too_far_behind');
        else {
          for (const e of r.entries) {
            conn.write(notificationFrame(inbox.epoch, e));
            conn.lastSeq = e.seq;
          }
          if (r.entries.length > 0) metrics.inc('sse_replayed_total', {}, r.entries.length);
          conn.lastSeq = Math.max(conn.lastSeq, cursor.seq);
        }
      }
      conn.goLive();

      req.raw.on('close', () => {
        conn.close();
        registry.remove(conn);
      });
    },
  );

  // ── Inbox ──────────────────────────────────────────────────────────────────
  server.get<{ Querystring: { before?: number; limit: number } }>(
    '/v1/notifications',
    { schema: { querystring: pageQuery }, preHandler: requirePlayer },
    async (req) => {
      const page = core.inboxService.page(req.playerId as PlayerId, req.query.before ?? null, req.query.limit);
      return { ...page, entries: page.entries.map(toInboxEntryDto) };
    },
  );

  server.post<{ Params: { id: string } }>(
    '/v1/notifications/:id/read',
    { schema: { params: idParams }, preHandler: requirePlayer },
    async (req, reply) =>
      core.inboxService.markRead(req.playerId as PlayerId, req.params.id as NotificationId)
        ? reply.code(204).send()
        : problem(reply, 404, 'Notification not found'),
  );

  server.post<{ Body: { upToSeq?: number } | null }>(
    '/v1/notifications/read-all',
    { schema: { body: readAllBody }, preHandler: requirePlayer },
    async (req) => ({ marked: core.inboxService.markAllRead(req.playerId as PlayerId, req.body?.upToSeq) }),
  );

  // ── Preferences (merge-patch + ETag/If-Match) ──────────────────────────────
  const etag = (v: number) => `"v${v}"`;
  server.get('/v1/preferences', { preHandler: requirePlayer }, async (req, reply) => {
    const p = core.preferences.get(req.playerId as PlayerId);
    reply.header('ETag', etag(p.version));
    return p;
  });

  server.patch<{ Body: PreferencesPatch }>(
    '/v1/preferences',
    { schema: { body: preferencesPatch }, preHandler: requirePlayer },
    async (req, reply) => {
      const ifMatch = req.headers['if-match'];
      let expected: number | undefined;
      if (typeof ifMatch === 'string' && ifMatch !== '*') {
        const m = /^(?:W\/)?"v(\d+)"$/.exec(ifMatch.trim());
        if (!m) return problem(reply, 400, 'Invalid If-Match header');
        expected = Number(m[1]);
      }
      const r = core.preferences.patch(req.playerId as PlayerId, req.body, expected);
      if (!r.ok) {
        return r.error.code === 'VERSION_CONFLICT'
          ? problem(reply, 412, 'Precondition Failed', 'Preferences were changed elsewhere; refetch and retry')
          : problem(reply, 400, 'Invalid preferences', r.error.message, { field: r.error.field });
      }
      reply.header('ETag', etag(r.value.version));
      return r.value;
    },
  );

  // ── Ingestion for real producers ───────────────────────────────────────────
  server.post<{ Body: Record<string, unknown> & { kind: string } }>(
    '/v1/events',
    { schema: { body: platformEventBody }, preHandler: [refuseWhenClosing, requireInternalKey] },
    async (req, reply) => {
      const body = req.body;
      const event = {
        ...body,
        eventId: EventId(typeof body.eventId === 'string' ? body.eventId : randomUUID()),
        occurredAt: typeof body.occurredAt === 'number' ? body.occurredAt : Date.now(),
      } as unknown as PlatformEvent;
      const unknown = unknownPlayer(body);
      if (unknown !== undefined) return problem(reply, 422, 'Unknown player', `Player ${unknown} is not in the player directory`);
      if (core.bus.publish(event) === 'rejected') {
        reply.header('Retry-After', '1');
        return problem(reply, 503, 'Event bus at capacity');
      }
      return reply.code(202).send({ accepted: true, eventId: event.eventId });
    },
  );

  // ── Dev simulator (drives the web demo; mirrors the brief's calls) ─────────
  server.post<{ Body: { action: SimulateAction; args: (number | string)[]; repeat: number } }>(
    '/v1/dev/simulate',
    { schema: { body: simulateBody }, preHandler: [refuseWhenClosing, devOnly] },
    async (req, reply) => {
      const { action, args, repeat } = req.body;
      const [a, b] = args;
      const results: string[] = [];
      const players = SIMULATE_PLAYER_ARGS[action] === 1 ? [a] : [a, b];
      const unknown = players.find((p) => !core.directory.get(Number(p) as PlayerId));
      if (unknown !== undefined) return problem(reply, 422, 'Unknown player', `Player ${unknown} is not in the player directory`);
      try {
        for (let i = 0; i < repeat; i++) results.push(simulate(core, action, Number(a), b as number | string));
      } catch (e) {
        return problem(reply, 400, 'Invalid simulation', (e as Error).message);
      }
      if (results.includes('rejected')) {
        reply.header('Retry-After', '1');
        return problem(reply, 503, 'Event bus at capacity');
      }
      return reply.code(202).send({ action, args, results });
    },
  );

  server.get<{ Querystring: { limit?: number } }>('/v1/admin/dlq', { preHandler: requireInternalKey }, async () =>
    core.dlq.list(100).map((d) => ({ ...d, entry: toInboxEntryDto(d.entry) })),
  );

  // ── Static web client (single origin → no CORS, cookies just work) ─────────
  const webDir = config.webDistDir ?? join(import.meta.dirname, '../../web/dist');
  if (existsSync(join(webDir, 'index.html'))) {
    await server.register(fastifyStatic, { root: webDir, wildcard: false });
    server.setNotFoundHandler((req, reply) =>
      req.method === 'GET' && !req.url.startsWith('/v1/') ? reply.sendFile('index.html') : problem(reply, 404, 'Not Found'),
    );
  } else {
    server.setNotFoundHandler((_req, reply) => problem(reply, 404, 'Not Found'));
  }

  registry.startHeartbeat(config.sse.heartbeatMs);

  return {
    server,
    core,
    registry,
    metricsRegistry,
    async close() {
      ready = false;
      closing = true;
      registry.stopHeartbeat();
      await core.shutdown();
      registry.closeAll();
      await server.close();
    },
  };
}

/** How many leading args of each simulate action are player ids. */
const SIMULATE_PLAYER_ARGS: Record<SimulateAction, 1 | 2> = {
  playerLeveledUp: 1,
  itemAcquired: 1,
  challengeCompleted: 1,
  playerAttacked: 2,
  playerDefeated: 2,
  friendRequestSent: 2,
  friendRequestAccepted: 2,
  playerFollowed: 2,
};

function simulate(core: Core, action: SimulateAction, a: number, b: number | string): string {
  const n = (v: number | string) => {
    const x = Number(v);
    if (!Number.isInteger(x)) throw new RangeError(`Expected an integer, got "${v}"`);
    return x;
  };
  switch (action) {
    case 'playerLeveledUp':
      return core.gameEngine.playerLeveledUp(a, n(b));
    case 'itemAcquired':
      return core.gameEngine.itemAcquired(a, String(b));
    case 'challengeCompleted':
      return core.gameEngine.challengeCompleted(a, String(b));
    case 'playerAttacked':
      return core.gameEngine.playerAttacked(a, n(b));
    case 'playerDefeated':
      return core.gameEngine.playerDefeated(a, n(b));
    case 'friendRequestSent':
      return core.socialSystem.friendRequestSent(a, n(b));
    case 'friendRequestAccepted':
      return core.socialSystem.friendRequestAccepted(a, n(b));
    case 'playerFollowed':
      return core.socialSystem.playerFollowed(a, n(b));
  }
}
