import type { Notification, NotificationDto } from './notification.ts';
import type { DeliveryMode } from './notification-type.ts';

export interface InboxEntry {
  /** Per-player, strictly increasing, contiguous, starts at 1. Used as the SSE event id. */
  readonly seq: number;
  readonly notification: Notification;
  readonly mode: DeliveryMode;
  deliveredAt: number | null;
  readAt: number | null;
}

export interface InboxEntryDto {
  readonly seq: number;
  readonly silent: boolean;
  readonly read: boolean;
  readonly notification: NotificationDto;
}

export const toInboxEntryDto = (e: InboxEntry): InboxEntryDto => ({
  seq: e.seq,
  silent: e.mode === 'SILENT',
  read: e.readAt !== null,
  notification: e.notification.toJSON(),
});
