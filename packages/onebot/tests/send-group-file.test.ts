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
// `bridge.apis.groupFile.publish`, which calls dedicated OIDB
// `OidbSvcTrpcTcp.0x6d9_4` — Lagrange.Core V2's
// `GroupSendFileService.cs`.

import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { OneBotInstanceContext } from '../src/instance-context';
import { sendGroupMessage } from '../src/modules/message-actions';

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
  it('file-only message routes through apis.groupFile.publish (not apis.message.sendGroup)', async () => {
    // Pure-file case — the elems[] path used to ship a transElem(24)
    // and got result=79. The dedicated OIDB-0x6d9_4 route must take
    // over for group file publishing.
    const sendGroupMessage_bridge = vi.fn();
    // Declare params on the fn so `mock.calls[0]` infers a tuple of
    // [groupId, fileId] instead of `[]` (which makes the destructuring
    // a tsc error under noUncheckedIndexedAccess).
    const publish = vi.fn(async (_groupId: number, _fileId: string) => undefined);
    const bridge = fakeBridge({
      apis: {
        message: { sendGroup: sendGroupMessage_bridge },
        groupFile: { publish },
      } as any,
      resolveUserUid: vi.fn(),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 12345, [{
      type: 'file', data: { file_id: 'gfid-abc', name: 'doc.txt', size: 123 },
    }] as any, false);

    expect(publish).toHaveBeenCalledOnce();
    expect(sendGroupMessage_bridge).not.toHaveBeenCalled();

    const [groupId, fileId] = publish.mock.calls[0]!;
    expect(groupId).toBe(12345);
    expect(fileId).toBe('gfid-abc');
  });

  it('mixed text + file splits across two sends (text via elems[], file via OIDB)', async () => {
    const sendGroupMessage_bridge = vi.fn(async (_gid: number, _elements: any[]) => goodReceipt);
    const publish = vi.fn(async (_groupId: number, _fileId: string) => undefined);
    const bridge = fakeBridge({
      apis: {
        message: { sendGroup: sendGroupMessage_bridge },
        groupFile: { publish },
      } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 12345, [
      { type: 'text', data: { text: 'here is the file:' } },
      { type: 'file', data: { file_id: 'gfid-xyz', name: 'pkg.zip' } },
    ] as any, false);

    expect(sendGroupMessage_bridge).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();

    const [textGid, textElements] = sendGroupMessage_bridge.mock.calls[0]!;
    expect(textGid).toBe(12345);
    expect(textElements).toEqual([{ type: 'text', text: 'here is the file:' }]);

    const [fileGid, fileFileId] = publish.mock.calls[0]!;
    expect(fileGid).toBe(12345);
    expect(fileFileId).toBe('gfid-xyz');
  });

  it('file segment without file_id is skipped (with a warn-level log)', async () => {
    const sendGroupMessage_bridge = vi.fn(async (_gid: number, _elements: any[]) => goodReceipt);
    const publish = vi.fn();
    const upload = vi.fn();
    const bridge = fakeBridge({
      apis: {
        message: { sendGroup: sendGroupMessage_bridge },
        groupFile: { publish, upload },
      } as any,
      resolveUserUid: vi.fn(),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 12345, [
      { type: 'text', data: { text: 'with bad file segment' } },
      { type: 'file', data: {} }, // no file_id and no url
    ] as any, false);

    expect(sendGroupMessage_bridge).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('file segment with url (no file_id) auto-uploads via groupFile.upload (not publish)', async () => {
    // Happy path for inline file sending: the bot passes a local path
    // directly. upload() internally calls publish(), so we must NOT
    // call publish() a second time.
    const upload = vi.fn(async (_gid: number, _src: string, _name: string, _folder: string, _doUpload: boolean) =>
      ({ fileId: 'auto-fid', fileHash: null }));
    const publish = vi.fn();
    const bridge = fakeBridge({
      apis: {
        message: { sendGroup: vi.fn() },
        groupFile: { upload, publish },
      } as any,
      resolveUserUid: vi.fn(),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 12345, [{
      type: 'file', data: { file: '/tmp/audio.wav', name: 'audio.wav' },
    }] as any, false);

    expect(upload).toHaveBeenCalledOnce();
    const [gid, src, name, folder, doUpload] = upload.mock.calls[0]!;
    expect(gid).toBe(12345);
    expect(src).toBe('/tmp/audio.wav');
    expect(name).toBe('audio.wav');
    expect(folder).toBe('/');
    expect(doUpload).toBe(true);
    // publish must NOT be called — upload() already handles it internally
    expect(publish).not.toHaveBeenCalled();
  });
});
