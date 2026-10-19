declare const brand: unique symbol;

/** Nominal typing at zero runtime cost: a PlayerId cannot be passed where an ItemId is expected. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PlayerId = Brand<number, 'PlayerId'>;
export type EventId = Brand<string, 'EventId'>;
export type NotificationId = Brand<string, 'NotificationId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type ChallengeId = Brand<string, 'ChallengeId'>;

export const PlayerId = (n: number): PlayerId => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`Invalid PlayerId: ${n}`);
  return n as PlayerId;
};

export const ItemId = (s: string): ItemId => {
  if (s.length === 0 || s.length > 64) throw new RangeError(`Invalid ItemId: "${s}"`);
  return s as ItemId;
};

export const ChallengeId = (s: string): ChallengeId => {
  if (s.length === 0 || s.length > 64) throw new RangeError(`Invalid ChallengeId: "${s}"`);
  return s as ChallengeId;
};

export const EventId = (s: string): EventId => s as EventId;
export const NotificationId = (s: string): NotificationId => s as NotificationId;
