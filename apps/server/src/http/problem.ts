import type { FastifyReply } from 'fastify';

/** RFC 9457 Problem Details. */
export const problem = (
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
) =>
  reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, ...(detail ? { detail } : {}), ...extra });
