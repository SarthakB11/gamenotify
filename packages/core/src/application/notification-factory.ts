import { Notification, type NotificationProps } from '../domain/index.ts';
import type { Clock, IdGenerator } from '../ports/index.ts';

/** The only place Notifications are constructed: assigns a time-ordered id (UUIDv7) and timestamp. */
export class NotificationFactory {
  readonly #ids: IdGenerator;
  readonly #clock: Clock;

  constructor(ids: IdGenerator, clock: Clock) {
    this.#ids = ids;
    this.#clock = clock;
  }

  create(props: NotificationProps): Notification {
    return Notification.create(this.#ids.notificationId(), this.#clock.now(), props);
  }
}
