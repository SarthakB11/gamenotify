import {
  type ChallengeId,
  type ItemId,
  ItemRarity,
  type NotificationIntent,
  type NotificationType,
  type PlayerId,
  rarityName,
} from '../../domain/index.ts';
import type { ContentCatalog } from '../../ports/index.ts';
import { humanizeId, plural } from './text.ts';

export interface RenderInput {
  readonly intent: NotificationIntent;
  /** Display name for a player id (already sanitised). */
  readonly name: (id: PlayerId) => string;
  readonly catalog: ContentCatalog;
}

export interface Rendered {
  readonly title: string;
  readonly message: string;
}

/** Template Method hook: one pure function per notification type. */
export type Template = (input: RenderInput) => Rendered;

const quoted = (input: RenderInput, id: PlayerId | undefined): string =>
  id === undefined ? 'Someone' : `Player '${input.name(id)}'`;

const leadActor = (input: RenderInput): PlayerId | undefined => input.intent.actorIds?.[0] ?? input.intent.actorId;

/** "Player 'Kael'" or "Player 'Kael' and 3 others" for grouped intents. */
const actorPhrase = (input: RenderInput): string => {
  const lead = quoted(input, leadActor(input));
  const others = (input.intent.distinctActors ?? 1) - 1;
  return others > 0 ? `${lead} and ${others} ${plural(others, 'other', 'others')}` : lead;
};

const itemView = (input: RenderInput): { name: string; rarity: string | null } => {
  const id = String(input.intent.params.itemId) as ItemId;
  const info = input.catalog.item(id);
  if (info === undefined) return { name: humanizeId(id), rarity: null };
  return { name: info.name, rarity: info.rarity >= ItemRarity.RARE ? rarityName(info.rarity).toLowerCase() : null };
};

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * English message catalog. `satisfies Record<NotificationType, Template>` makes a missing
 * translation a compile error when a new type is added. i18n = another catalog keyed by locale.
 */
export const EN_CATALOG = Object.freeze({
  LEVEL_UP: ({ intent }) => ({
    title: 'Level Up!',
    message: `Congratulations! You've reached level ${Number(intent.params.level)}!`,
  }),
  ITEM_ACQUIRED: (input) => {
    const item = itemView(input);
    return item.rarity === null
      ? { title: 'Item Acquired', message: `You've acquired the ${item.name}!` }
      : { title: `${capitalize(item.rarity)} Item Acquired`, message: `You've acquired the ${item.rarity} ${item.name}!` };
  },
  CHALLENGE_COMPLETED: ({ intent, catalog }) => {
    const id = String(intent.params.challengeId) as ChallengeId;
    const name = catalog.challenge(id)?.name ?? humanizeId(id);
    return { title: 'Challenge Completed', message: `Challenge complete! You've conquered '${name}'.` };
  },
  PVP_ATTACKED: (input) => {
    const count = input.intent.groupCount ?? 1;
    const distinct = input.intent.distinctActors ?? 1;
    if (count > 1 && distinct === 1) {
      const lead = leadActor(input);
      // "more times" is only true if the attacker also triggered the already-delivered first notification.
      const repeat = lead !== undefined && lead === input.intent.leadingActorId;
      return {
        title: 'Under Attack!',
        message: `${quoted(input, lead)} attacked you ${count}${repeat ? ' more' : ''} ${plural(count, 'time', 'times')}!`,
      };
    }
    return { title: 'Under Attack!', message: `You're under attack by ${actorPhrase(input)}!` };
  },
  PVP_DEFEATED: (input) => ({
    title: 'Defeated',
    message: `You were defeated by ${quoted(input, input.intent.actorId)}.`,
  }),
  PVP_VICTORY: (input) => ({
    title: 'Victory!',
    message: `You defeated ${quoted(input, input.intent.actorId)}!`,
  }),
  FRIEND_REQUEST: (input) => ({
    title: 'Friend Request',
    message: `${quoted(input, input.intent.actorId)} has sent you a friend request.`,
  }),
  FRIEND_ACCEPTED: (input) => ({
    title: 'Friend Request Accepted',
    message: `${quoted(input, input.intent.actorId)} accepted your friend request.`,
  }),
  NEW_FOLLOWER: (input) => ({
    title: (input.intent.groupCount ?? 1) > 1 ? 'New Followers' : 'New Follower',
    message: `${actorPhrase(input)} started following you.`,
  }),
} satisfies Record<NotificationType, Template>);

export type MessageCatalog = Readonly<Record<NotificationType, Template>>;
