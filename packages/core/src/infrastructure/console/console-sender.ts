import type { InboxEntry } from '../../domain/index.ts';
import type { DeliveryResult, NotificationSender, PlayerDirectory } from '../../ports/index.ts';

export interface ConsoleSenderOptions {
  readonly write: (line: string) => void;
  readonly directory: PlayerDirectory;
  readonly color?: boolean;
}

const c = (on: boolean, code: string, s: string): string => (on ? `\u001b[${code}m${s}\u001b[0m` : s);

/** Mock of the game client's receiver for the console demo: prints each delivered notification. */
export class ConsoleNotificationSender implements NotificationSender {
  readonly name = 'console';
  readonly #o: ConsoleSenderOptions;

  constructor(opts: ConsoleSenderOptions) {
    this.#o = opts;
  }

  send(entry: InboxEntry): DeliveryResult {
    const n = entry.notification;
    const color = this.#o.color ?? false;
    const who = `#${n.recipientId} ${this.#o.directory.get(n.recipientId)?.displayName ?? '?'}`.padEnd(9);
    const tag = `[${n.category}/${n.type}]`.padEnd(30);
    this.#o.write(`${c(color, '32', '→')} ${c(color, '1', who)} ${c(color, '36', tag)} ${n.message}`);
    return 'DELIVERED';
  }
}
