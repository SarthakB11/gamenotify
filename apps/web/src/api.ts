export type Category = 'GAME' | 'SOCIAL';
export type NotificationType =
  | 'LEVEL_UP'
  | 'ITEM_ACQUIRED'
  | 'CHALLENGE_COMPLETED'
  | 'PVP_ATTACKED'
  | 'PVP_DEFEATED'
  | 'PVP_VICTORY'
  | 'FRIEND_REQUEST'
  | 'FRIEND_ACCEPTED'
  | 'NEW_FOLLOWER';

export const TYPES: { type: NotificationType; category: Category; label: string }[] = [
  { type: 'LEVEL_UP', category: 'GAME', label: 'Level up' },
  { type: 'ITEM_ACQUIRED', category: 'GAME', label: 'Rare item' },
  { type: 'CHALLENGE_COMPLETED', category: 'GAME', label: 'Challenge' },
  { type: 'PVP_ATTACKED', category: 'GAME', label: 'PvP attacked' },
  { type: 'PVP_DEFEATED', category: 'GAME', label: 'PvP defeated' },
  { type: 'PVP_VICTORY', category: 'GAME', label: 'PvP victory' },
  { type: 'FRIEND_REQUEST', category: 'SOCIAL', label: 'Friend request' },
  { type: 'FRIEND_ACCEPTED', category: 'SOCIAL', label: 'Friend accepted' },
  { type: 'NEW_FOLLOWER', category: 'SOCIAL', label: 'New follower' },
];

export interface NotificationDto {
  id: string;
  recipientId: number;
  type: NotificationType;
  category: Category;
  priority: number;
  title: string;
  message: string;
  data: Record<string, unknown>;
  groupCount: number;
  createdAt: string;
}

export interface Entry {
  seq: number;
  silent: boolean;
  read: boolean;
  notification: NotificationDto;
}

export interface Preferences {
  categories: Record<Category, boolean>;
  typeOverrides: Partial<Record<NotificationType, boolean>>;
  mutedUntil: number | null;
  quietHours: { start: string; end: string; timeZone: string } | null;
  version: number;
}

export interface Player {
  id: number;
  displayName: string;
}

export class Api {
  readonly #token: string | null;

  constructor(token: string | null) {
    this.#token = token;
  }

  private async call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.#token) headers.set('authorization', `Bearer ${this.#token}`);
    if (init.json !== undefined) headers.set('content-type', 'application/json');
    const res = await fetch(path, { ...init, headers, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });
    if (!res.ok) {
      const p = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
      throw new Error(p.detail ?? p.title ?? `HTTP ${res.status}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  players = () => this.call<Player[]>('/v1/players');
  login = (playerId: number) =>
    this.call<{ token: string; displayName: string }>('/v1/dev/login', { method: 'POST', json: { playerId } });
  streamTicket = () => this.call<{ ticket: string; expiresInMs: number }>('/v1/stream/ticket', { method: 'POST' });
  inbox = () => this.call<{ epoch: string; entries: Entry[]; unread: number }>('/v1/notifications?limit=50');
  markRead = (id: string) => this.call<void>(`/v1/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
  markAllRead = () => this.call<{ marked: number }>('/v1/notifications/read-all', { method: 'POST', json: {} });
  preferences = () => this.call<Preferences>('/v1/preferences');
  patchPreferences = (patch: Record<string, unknown>) =>
    this.call<Preferences>('/v1/preferences', { method: 'PATCH', json: patch });
  simulate = (action: string, args: (number | string)[], repeat = 1) =>
    this.call<unknown>('/v1/dev/simulate', { method: 'POST', json: { action, args, repeat } });
}
