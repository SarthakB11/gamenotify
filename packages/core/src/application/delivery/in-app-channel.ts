import type { InboxEntry } from '../../domain/index.ts';
import type { DeliveryChannel, DeliveryResult, NotificationSender } from '../../ports/index.ts';

/** The only channel the brief requires. Adapts whichever NotificationSender is wired (SSE, console, test). */
export class InAppChannel implements DeliveryChannel {
  readonly name = 'in_app';
  readonly #sender: NotificationSender;

  constructor(sender: NotificationSender) {
    this.#sender = sender;
  }

  accepts(): boolean {
    return true;
  }

  send(entry: InboxEntry): Promise<DeliveryResult> | DeliveryResult {
    return this.#sender.send(entry);
  }
}
