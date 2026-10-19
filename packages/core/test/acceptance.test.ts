import { describe, expect, it } from 'vitest';
import { makeCore } from './helpers.ts';

/** T-01: the brief's example triggers produce exactly these notifications, to these players, in order. */
describe('brief acceptance — example event triggers', () => {
  it('delivers the four example notifications', async () => {
    const { core, sender } = makeCore();

    core.gameEngine.playerLeveledUp(1, 15); // User 1 leveled up to 15
    core.gameEngine.itemAcquired(2, 'SwordOfAzeroth'); // User 2 acquired an item
    core.socialSystem.friendRequestSent(3, 1); // User 3 sent a friend request to user 1
    core.socialSystem.friendRequestAccepted(1, 3); // User 1 accepted friend request from 3
    await core.settle();

    expect(sender.sent.map((e) => [e.notification.recipientId, e.notification.type, e.notification.message])).toEqual([
      [1, 'LEVEL_UP', "Congratulations! You've reached level 15!"],
      [2, 'ITEM_ACQUIRED', "You've acquired the legendary Sword of Azeroth!"],
      [1, 'FRIEND_REQUEST', "Player 'Kael' has sent you a friend request."],
      [3, 'FRIEND_ACCEPTED', "Player 'Aria' accepted your friend request."],
    ]);
  });

  it('respects the category preference map (Game / Social)', async () => {
    const { core, sender, suppressed } = makeCore();
    core.preferences.patch(1 as never, { categories: { SOCIAL: false } });

    core.socialSystem.friendRequestSent(3, 1);
    core.gameEngine.playerLeveledUp(1, 16);
    await core.settle();

    expect(sender.messages()).toEqual(["Congratulations! You've reached level 16!"]);
    expect(suppressed).toEqual([{ recipientId: 1, type: 'FRIEND_REQUEST', reason: 'CATEGORY_DISABLED' }]);
  });

  it('stores every created notification in the recipient inbox with contiguous seqs', async () => {
    const { core } = makeCore();
    core.gameEngine.playerLeveledUp(1, 2);
    core.gameEngine.playerLeveledUp(1, 3);
    core.socialSystem.friendRequestSent(2, 1);
    await core.settle();
    const page = core.inboxService.page(1 as never, null, 10);
    expect(page.entries.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(page.unread).toBe(3);
  });
});
