import { describe, expect, it, vi } from 'vitest';
import { sendPrivateMessage } from '../src/modules/message-actions';
import { TempSessionStore } from '../src/temp-session-store';
import type { OneBotInstanceContext } from '../src/instance-context';

// The passive gate lives at the very top of sendPrivateMessage, before any
// message parsing or network call. These tests exercise that gate directly:
// a temp reply (tempGroupId set) into a session the peer never opened MUST be
// refused, without ever reaching the send path. This is the structural
// guarantee that the public build cannot initiate a temp session.

function refWith(store: TempSessionStore): OneBotInstanceContext {
  const sendGroupTempMessage = vi.fn();
  const sendPrivate = vi.fn();
  return {
    tempSessions: store,
    // If the gate ever let a send through, these would be called — the tests
    // assert they are NOT for the refused case.
    bridge: { apis: { message: { sendGroupTempMessage, sendPrivate } } },
  } as unknown as OneBotInstanceContext;
}

describe('sendPrivateMessage temp-session gate (passive-only)', () => {
  it('refuses a temp reply to an unrecorded (user, group) and never sends', async () => {
    const store = new TempSessionStore();
    const ref = refWith(store);
    await expect(
      sendPrivateMessage(ref, 1001, [{ type: 'text', data: { text: 'hi' } }], false, /* tempGroupId */ 700),
    ).rejects.toThrow(/passive-only|temp session/i);
    // The gate threw before any wire call.
    expect((ref.bridge.apis.message as { sendGroupTempMessage: ReturnType<typeof vi.fn> }).sendGroupTempMessage)
      .not.toHaveBeenCalled();
  });

  it('refuses when a DIFFERENT group is recorded (exact (user, group) match required)', async () => {
    const store = new TempSessionStore();
    store.record(1001, 701); // user opened a session from group 701, not 700
    const ref = refWith(store);
    await expect(
      sendPrivateMessage(ref, 1001, [{ type: 'text', data: { text: 'hi' } }], false, 700),
    ).rejects.toThrow(/passive-only|temp session/i);
  });

  it('rejects text + file before sending a partial temp-session message', async () => {
    const store = new TempSessionStore();
    store.record(1001, 700);
    const ref = refWith(store);

    await expect(sendPrivateMessage(ref, 1001, [
      { type: 'text', data: { text: 'must not be sent' } },
      { type: 'file', data: { file_id: 'friend-file-id' } },
    ], false, 700)).rejects.toMatchObject({
      code: 'UNSENDABLE_TYPE',
      elementType: 'file',
    });

    expect((ref.bridge.apis.message as { sendGroupTempMessage: ReturnType<typeof vi.fn> }).sendGroupTempMessage)
      .not.toHaveBeenCalled();
  });
});
