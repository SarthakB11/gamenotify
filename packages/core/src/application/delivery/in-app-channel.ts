import { DeliveryMode, type InboxEntry } from '../../domain/index.ts';
import type { DeliveryChannel, DeliveryResult, NotificationSender } from '../../ports/index.ts';

/**
 * The only channel the brief requires. Adapts whichever NotificationSender is wired (SSE, console, test).
 * SILENT entries (muted, quiet hours, rate-limited) reach only senders that carry the silent flag to the client
 * (SSE): an alert-only sender such as the console demo never sees them.
 */
export class InAppChannel implements DeliveryChannel {
  readonly name = 'in_app';
  readonly #sender: NotificationSender;

  constructor(sender: NotificationSender) {
    this.#sender = sender;
  }

  accepts(entry: InboxEntry): boolean {
    return entry.mode === DeliveryMode.LIVE || this.#sender.carriesSilent === true;
  }

  send(entry: InboxEntry): Promise<DeliveryResult> | DeliveryResult {
    return this.#sender.send(entry);
  }
}
