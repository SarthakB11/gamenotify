export const NotificationCategory = { GAME: 'GAME', SOCIAL: 'SOCIAL' } as const;
export type NotificationCategory = (typeof NotificationCategory)[keyof typeof NotificationCategory];
export const ALL_CATEGORIES: readonly NotificationCategory[] = Object.freeze(Object.values(NotificationCategory));

export const NotificationType = {
  LEVEL_UP: 'LEVEL_UP',
  ITEM_ACQUIRED: 'ITEM_ACQUIRED',
  CHALLENGE_COMPLETED: 'CHALLENGE_COMPLETED',
  PVP_ATTACKED: 'PVP_ATTACKED',
  PVP_DEFEATED: 'PVP_DEFEATED',
  PVP_VICTORY: 'PVP_VICTORY',
  FRIEND_REQUEST: 'FRIEND_REQUEST',
  FRIEND_ACCEPTED: 'FRIEND_ACCEPTED',
  NEW_FOLLOWER: 'NEW_FOLLOWER',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];
export const ALL_NOTIFICATION_TYPES: readonly NotificationType[] = Object.freeze(Object.values(NotificationType));

export const Priority = { LOW: 0, NORMAL: 1, HIGH: 2 } as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

/** LIVE = pushed in real time and stored. SILENT = stored in the inbox only (muted, quiet hours, rate-limited). */
export const DeliveryMode = { LIVE: 'LIVE', SILENT: 'SILENT' } as const;
export type DeliveryMode = (typeof DeliveryMode)[keyof typeof DeliveryMode];

export const ItemRarity = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4 } as const;
export type ItemRarity = (typeof ItemRarity)[keyof typeof ItemRarity];
export type ItemRarityName = keyof typeof ItemRarity;

export const rarityName = (r: ItemRarity): ItemRarityName =>
  (Object.keys(ItemRarity) as ItemRarityName[]).find((k) => ItemRarity[k] === r) ?? 'COMMON';

export const parseRarity = (s: string): ItemRarity => {
  const key = s.toUpperCase() as ItemRarityName;
  if (!(key in ItemRarity)) throw new RangeError(`Unknown rarity "${s}"`);
  return ItemRarity[key];
};

/** Single source of truth for per-type behaviour. Adding a type = adding one row (the compiler enforces it). */
export interface TypeMeta {
  readonly category: NotificationCategory;
  readonly priority: Priority;
  /** Eligible for burst grouping ("X and 3 others ..."). */
  readonly groupable: boolean;
}

export const TYPE_META: Readonly<Record<NotificationType, TypeMeta>> = Object.freeze({
  LEVEL_UP: { category: 'GAME', priority: Priority.NORMAL, groupable: false },
  ITEM_ACQUIRED: { category: 'GAME', priority: Priority.NORMAL, groupable: false },
  CHALLENGE_COMPLETED: { category: 'GAME', priority: Priority.NORMAL, groupable: false },
  PVP_ATTACKED: { category: 'GAME', priority: Priority.HIGH, groupable: true },
  PVP_DEFEATED: { category: 'GAME', priority: Priority.NORMAL, groupable: false },
  PVP_VICTORY: { category: 'GAME', priority: Priority.NORMAL, groupable: false },
  FRIEND_REQUEST: { category: 'SOCIAL', priority: Priority.NORMAL, groupable: false },
  FRIEND_ACCEPTED: { category: 'SOCIAL', priority: Priority.NORMAL, groupable: false },
  NEW_FOLLOWER: { category: 'SOCIAL', priority: Priority.LOW, groupable: true },
} satisfies Record<NotificationType, TypeMeta>);
