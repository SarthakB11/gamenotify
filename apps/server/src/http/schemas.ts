import { ALL_NOTIFICATION_TYPES } from '@gamenotify/core';

const playerId = { type: 'integer', minimum: 1 } as const;
const shortString = { type: 'string', minLength: 1, maxLength: 64 } as const;
const clock = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } as const;

export const loginBody = {
  type: 'object',
  required: ['playerId'],
  additionalProperties: false,
  properties: { playerId },
} as const;

export const pageQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    before: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
} as const;

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

export const readAllBody = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: { upToSeq: { type: 'integer', minimum: 0 } },
} as const;

export const preferencesPatch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    categories: {
      type: 'object',
      additionalProperties: false,
      properties: { GAME: { type: 'boolean' }, SOCIAL: { type: 'boolean' } },
    },
    typeOverrides: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(ALL_NOTIFICATION_TYPES.map((t) => [t, { type: ['boolean', 'null'] }])),
    },
    mutedUntil: { type: ['integer', 'null'], minimum: 0 },
    muteForMinutes: { type: 'integer', minimum: 0, maximum: 43_200 },
    quietHours: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          required: ['start', 'end', 'timeZone'],
          additionalProperties: false,
          properties: { start: clock, end: clock, timeZone: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      ],
    },
  },
} as const;

const event = (kind: string, props: Record<string, unknown>) => ({
  type: 'object',
  required: ['kind', ...Object.keys(props)],
  additionalProperties: false,
  properties: {
    kind: { const: kind },
    eventId: { type: 'string', minLength: 1, maxLength: 64 },
    occurredAt: { type: 'integer', minimum: 0 },
    ...props,
  },
});

/** Ingestion contract for real producers (POST /v1/events). */
export const platformEventBody = {
  oneOf: [
    event('game.player_leveled_up', { playerId, newLevel: { type: 'integer', minimum: 1 } }),
    event('game.item_acquired', { playerId, itemId: shortString }),
    event('game.challenge_completed', { playerId, challengeId: shortString }),
    event('game.pvp_attacked', { attackerId: playerId, victimId: playerId }),
    event('game.pvp_defeated', { winnerId: playerId, loserId: playerId }),
    event('social.friend_request_sent', { senderId: playerId, recipientId: playerId }),
    event('social.friend_request_accepted', { accepterId: playerId, requesterId: playerId }),
    event('social.player_followed', { followerId: playerId, followeeId: playerId }),
  ],
} as const;

export const SIMULATE_ACTIONS = [
  'playerLeveledUp',
  'itemAcquired',
  'challengeCompleted',
  'playerAttacked',
  'playerDefeated',
  'friendRequestSent',
  'friendRequestAccepted',
  'playerFollowed',
] as const;
export type SimulateAction = (typeof SIMULATE_ACTIONS)[number];

/** Mirrors the brief: { "action": "playerLeveledUp", "args": [1, 15] }. */
export const simulateBody = {
  type: 'object',
  required: ['action', 'args'],
  additionalProperties: false,
  properties: {
    action: { enum: SIMULATE_ACTIONS },
    args: { type: 'array', minItems: 2, maxItems: 2, items: { type: ['integer', 'string'] } },
    repeat: { type: 'integer', minimum: 1, maximum: 50, default: 1 },
  },
} as const;
