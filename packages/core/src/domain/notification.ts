import type { EventId, NotificationId, PlayerId } from './ids.ts';
import type { JsonObject } from './json.ts';
import { type NotificationCategory, type NotificationType, type Priority, TYPE_META } from './notification-type.ts';

export const MAX_MESSAGE_LENGTH = 280;

export interface NotificationProps {
  readonly recipientId: PlayerId;
  readonly type: NotificationType;
  /** Short headline, e.g. "Level Up!". */
  readonly title: string;
  /** Human-readable text, e.g. "Congratulations! You've reached level 15!". */
  readonly message: string;
  /** Structured parameters so clients can render icons / deep links without parsing text. */
  readonly data: JsonObject;
  readonly sourceEventId: EventId;
  readonly groupKey?: string;
  readonly groupCount?: number;
}

/** Wire representation (what the game client receives). */
export interface NotificationDto {
  readonly id: string;
  readonly recipientId: number;
  readonly type: NotificationType;
  readonly category: NotificationCategory;
  readonly priority: Priority;
  readonly title: string;
  readonly message: string;
  readonly data: JsonObject;
  readonly sourceEventId: string;
  readonly groupKey: string | null;
  readonly groupCount: number;
  readonly createdAt: string;
}

/**
 * The brief states a Notification class is "provided"; it was not included in the PDF,
 * so this is our definition (see README / HLD assumption A1).
 *
 * Immutable and channel-agnostic. Category and priority are derived from the type, so they can
 * never disagree with TYPE_META. Construct through {@link NotificationFactory}.
 */
export class Notification {
  readonly id: NotificationId;
  readonly recipientId: PlayerId;
  readonly type: NotificationType;
  readonly category: NotificationCategory;
  readonly priority: Priority;
  readonly title: string;
  readonly message: string;
  readonly data: JsonObject;
  readonly sourceEventId: EventId;
  readonly groupKey: string | null;
  readonly groupCount: number;
  /** Epoch milliseconds (cheaper than Date on the hot path). */
  readonly createdAt: number;

  private constructor(id: NotificationId, createdAt: number, p: NotificationProps) {
    const meta = TYPE_META[p.type];
    this.id = id;
    this.recipientId = p.recipientId;
    this.type = p.type;
    this.category = meta.category;
    this.priority = meta.priority;
    this.title = p.title;
    this.message = p.message;
    this.data = p.data;
    this.sourceEventId = p.sourceEventId;
    this.groupKey = p.groupKey ?? null;
    this.groupCount = p.groupCount ?? 1;
    this.createdAt = createdAt;
    Object.freeze(this);
  }

  static create(id: NotificationId, createdAt: number, props: NotificationProps): Notification {
    if (props.message.length === 0 || props.message.length > MAX_MESSAGE_LENGTH) {
      throw new RangeError(`Notification message must be 1..${MAX_MESSAGE_LENGTH} chars`);
    }
    if (props.title.length === 0) throw new RangeError('Notification title must not be empty');
    if (props.groupCount !== undefined && (!Number.isInteger(props.groupCount) || props.groupCount < 1)) {
      throw new RangeError('groupCount must be a positive integer');
    }
    return new Notification(id, createdAt, props);
  }

  toJSON(): NotificationDto {
    return {
      id: this.id,
      recipientId: this.recipientId,
      type: this.type,
      category: this.category,
      priority: this.priority,
      title: this.title,
      message: this.message,
      data: this.data,
      sourceEventId: this.sourceEventId,
      groupKey: this.groupKey,
      groupCount: this.groupCount,
      createdAt: new Date(this.createdAt).toISOString(),
    };
  }
}
