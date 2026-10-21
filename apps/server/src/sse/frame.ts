import { type InboxEntry, toInboxEntryDto } from '@gamenotify/core';
import fastJson from 'fast-json-stringify';

/** Precompiled serializer for the fixed frame shape (faster than JSON.stringify, and schema-guarded). */
const stringifyEntry = fastJson({
  type: 'object',
  properties: {
    seq: { type: 'integer' },
    silent: { type: 'boolean' },
    read: { type: 'boolean' },
    notification: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        recipientId: { type: 'integer' },
        type: { type: 'string' },
        category: { type: 'string' },
        priority: { type: 'integer' },
        title: { type: 'string' },
        message: { type: 'string' },
        data: { type: 'object', additionalProperties: true },
        sourceEventId: { type: 'string' },
        groupKey: { type: 'string', nullable: true },
        groupCount: { type: 'integer' },
        createdAt: { type: 'string' },
      },
      required: ['id', 'recipientId', 'type', 'category', 'priority', 'title', 'message', 'data', 'createdAt'],
    },
  },
  required: ['seq', 'silent', 'notification'],
});

export const cursorId = (epoch: string, seq: number): string => `${epoch}-${seq}`;

const CURSOR_RE = /^([A-Za-z0-9]{1,32})-(\d{1,15})$/;

export const parseCursor = (raw: unknown): { epoch: string; seq: number } | null => {
  if (typeof raw !== 'string') return null;
  const m = CURSOR_RE.exec(raw.trim());
  if (!m) return null;
  const seq = Number(m[2]);
  return Number.isSafeInteger(seq) ? { epoch: m[1] as string, seq } : null;
};

// One serialized frame per entry, shared by all of the player's connections (multi-device fan-out).
// `read` is the only field that changes after creation (false → true), so it is part of the cache key.
const cache = new WeakMap<InboxEntry, { read: boolean; frame: string }>();

export const notificationFrame = (epoch: string, entry: InboxEntry): string => {
  const read = entry.readAt !== null;
  const hit = cache.get(entry);
  if (hit !== undefined && hit.read === read) return hit.frame;
  const frame = `id: ${cursorId(epoch, entry.seq)}\nevent: notification\ndata: ${stringifyEntry(toInboxEntryDto(entry))}\n\n`;
  cache.set(entry, { read, frame });
  return frame;
};

export const controlFrame = (event: string, data: unknown, id?: string): string =>
  `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const HEARTBEAT_FRAME = ':hb\n\n';
