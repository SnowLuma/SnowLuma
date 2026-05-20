// Regression coverage for the group-file-in-send_group_msg bug.
//
// Symptom in the wild: bot uploaded a group file via `upload_group_file`,
// then sent `{type:'file', file_id}` through `send_group_msg`; the
// element-builder wrapped it as `transElem(elemType=24, ...)` inside
// `richText.elems` and shipped a regular `MessageSvc.PbSendMsg`. The
// QQ-NT server rejected the message with `result=79` because that wire
// shape is RECEIVE-side only (rich-body-decoder unpacks it into a
// FileEntity for inbound messages, but the server's intake validator
// flags it on the send side).
//
// Fix: split file segments off at the OneBot layer (same pattern as
// the c2c-file split for private messages) and dispatch through
// `bridge.sendGroupFileMessage`, which calls dedicated OIDB
// `OidbSvcTrpcTcp.0x6d9_4` — Lagrange.Core V2's
// `GroupSendFileService.cs`.

import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { OneBotInstanceContext } from '../../src/onebot/instance-context';
import { sendGroupMessage } from '../../src/onebot/modules/message-actions';

function fakeBridge(overrides: Partial<BridgeInterface> = {}): BridgeInterface {
  return new Proxy(overrides as BridgeInterface, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      throw new Error(`fakeBridge: '${String(prop)}' was not stubbed for this test`);
    },
  });
}

function makeCtx(bridge: BridgeInterface): OneBotInstanceContext {
  return {
    uin: '10001',
    bridge,
    messageStore: { findEvent: () => null, resolveReplySequence: () => 0 } as any,
    cacheMessageMeta: vi.fn(),
    mediaStore: {} as any,
    musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
}

const goodReceipt = {
  messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
};

describe('send_group_msg with {type:"file"} segment', () => {
  it('file-only message routes through sendGroupFileMessage (not sendGroupMessage_bridge)', async () => {
    // Pure-file case — the elems[] path used to ship a transElem(24)
    // and got result=79. The dedicated OIDB-0x6d9_4 route must take
    // over for group file publishing.
    const sendGroupMessage_bridge = vi.fn();
    const sendGroupFileMessage = vi.fn(async () => undefined);
    const bridge = fakeBridge({
      sendGroupMessage: sendGroupMessage_bridge,
      sendGroupFileMessage,
      resolveUserUid: vi.fn(),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 12345, [{
      type: 'file', data: { file_id: 'gfid-abc', name: 'doc.txt', size: 123 },
    }] as any, false);

    expect(sendGroupFileMessage).toHaveBeenCalledOnce();
    expect(sendGroupMessage_bridge).not.toHaveBeenCalled();

    const [groupId, fileId] = sendGroupFileMessage.mock.calls[0]!;
    expect(groupId).toBe(12345);
    expect(fileId).toBe('gfid-abc');
  });

  it('mixed text + file splits across two sends (text via elems[], file via OIDB)', async () => {
    const sendGroupMessage_bridge = vi.fn(async (_gid: number, _elements: any[]) => goodReceipt);
    const sendGroupFileMessage = vi.fn(async () => undefined);
    const bridge = fakeBridge({
      sendGroupMessage: sendGroupMessage_bridge,
      sendGroupFileMessage,
      resolveUserUid: vi.fn(async () => 'u_peer'),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 12345, [
      { type: 'text', data: { text: 'here is the file:' } },
      { type: 'file', data: { file_id: 'gfid-xyz', name: 'pkg.zip' } },
    ] as any, false);

    expect(sendGroupMessage_bridge).toHaveBeenCalledOnce();
    expect(sendGroupFileMessage).toHaveBeenCalledOnce();

    const [textGid, textElements] = sendGroupMessage_bridge.mock.calls[0]!;
    expect(textGid).toBe(12345);
    expect(textElements).toEqual([{ type: 'text', text: 'here is the file:' }]);

    const [fileGid, fileFileId] = sendGroupFileMessage.mock.calls[0]!;
    expect(fileGid).toBe(12345);
    expect(fileFileId).toBe('gfid-xyz');
  });

  it('file segment without file_id is skipped (with a warn-level log)', async () => {
    // Same upload-by-reference contract as the c2c file path —
    // missing file_id means there's nothing to publish.
    const sendGroupMessage_bridge = vi.fn(async (_gid: number, _elements: any[]) => goodReceipt);
    const sendGroupFileMessage = vi.fn();
    const bridge = fakeBridge({
      sendGroupMessage: sendGroupMessage_bridge,
      sendGroupFileMessage,
      resolveUserUid: vi.fn(),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 12345, [
      { type: 'text', data: { text: 'with bad file segment' } },
      { type: 'file', data: {} }, // no file_id
    ] as any, false);

    expect(sendGroupMessage_bridge).toHaveBeenCalledOnce();
    expect(sendGroupFileMessage).not.toHaveBeenCalled();
  });
});
