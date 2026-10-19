import type { JsonObject, Notification, NotificationIntent, PlayerId } from '../../domain/index.ts';
import type { ContentCatalog, PlayerDirectory } from '../../ports/index.ts';
import type { NotificationFactory } from '../notification-factory.ts';
import type { MessageCatalog, RenderInput } from './catalog-en.ts';
import { sanitizeName } from './text.ts';

/**
 * Turns a surviving intent into an immutable Notification: resolve names → pick template → build data.
 * Runs only after every filter passed ("render late").
 */
export class NotificationRenderer {
  readonly #catalog: MessageCatalog;
  readonly #directory: PlayerDirectory;
  readonly #content: ContentCatalog;
  readonly #factory: NotificationFactory;
  readonly #name: (id: PlayerId) => string;

  constructor(catalog: MessageCatalog, directory: PlayerDirectory, content: ContentCatalog, factory: NotificationFactory) {
    this.#catalog = catalog;
    this.#directory = directory;
    this.#content = content;
    this.#factory = factory;
    this.#name = (id) => {
      const p = this.#directory.get(id);
      return p ? sanitizeName(p.displayName) || `#${id}` : `#${id}`;
    };
  }

  render(intent: NotificationIntent): Notification {
    const input: RenderInput = { intent, name: this.#name, catalog: this.#content };
    const { title, message } = this.#catalog[intent.type](input);
    return this.#factory.create({
      recipientId: intent.recipientId,
      type: intent.type,
      title,
      message,
      data: this.#data(intent),
      sourceEventId: intent.sourceEventId,
      ...(intent.groupKey !== undefined ? { groupKey: intent.groupKey } : {}),
      ...(intent.groupCount !== undefined ? { groupCount: intent.groupCount } : {}),
    });
  }

  #data(intent: NotificationIntent): JsonObject {
    const actorIds = intent.actorIds ?? (intent.actorId !== undefined ? [intent.actorId] : undefined);
    const extra: Record<string, unknown> = {};
    if (intent.type === 'ITEM_ACQUIRED') {
      const item = this.#content.item(String(intent.params.itemId) as never);
      if (item) extra.rarity = item.rarity;
    }
    return {
      ...intent.params,
      ...(actorIds ? { actorIds: [...actorIds] } : {}),
      ...(intent.distinctActors !== undefined ? { distinctActors: intent.distinctActors } : {}),
      ...(extra as JsonObject),
    };
  }
}
