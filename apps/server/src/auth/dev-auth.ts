import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlayerId } from '@gamenotify/core';
import type { FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'gid';
const TTL_MS = 12 * 60 * 60 * 1000;

const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

/**
 * Dev-grade session tokens: base64url("playerId.exp") + "." + HMAC-SHA256.
 * Production swaps this for the IdP (OIDC/JWT) behind the same `authenticate()` contract.
 */
export class DevAuthenticator {
  readonly #secret: string;
  readonly #now: () => number;

  constructor(secret: string, now: () => number = Date.now) {
    this.#secret = secret;
    this.#now = now;
  }

  issue(player: PlayerId): string {
    const payload = b64(`${player}.${this.#now() + TTL_MS}`);
    return `${payload}.${this.#sign(payload)}`;
  }

  verify(token: string | undefined): PlayerId | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.#sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const [id, exp] = Buffer.from(payload, 'base64url').toString().split('.');
    if (Number(exp) <= this.#now()) return null;
    try {
      return PlayerId(Number(id));
    } catch {
      return null;
    }
  }

  /** Bearer token (services, tests, per-tab web sessions) → session cookie. The SSE route also takes a stream ticket. */
  authenticate(req: FastifyRequest): PlayerId | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return this.verify(auth.slice(7));
    return this.verify(readCookie(req.headers.cookie, SESSION_COOKIE));
  }

  cookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure ? '; Secure' : ''}`;
  }

  #sign(payload: string): string {
    return createHmac('sha256', this.#secret).update(payload).digest('base64url');
  }
}

export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
};
