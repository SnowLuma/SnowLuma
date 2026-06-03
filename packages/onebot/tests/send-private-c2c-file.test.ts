// Regression coverage for the c2c-file-in-send_private_msg bug.
//
// Symptom in the wild: bot called `send_private_msg` with a
// `{type:'file', file_id}` segment; the OneBot module passed it
// straight to `bridge.sendPrivateMessage(userId, [fileElement])`;
// `buildSendElems` warned ("file send via elems[] is group-only")
// and dropped it; the resulting wire send had 0 elems and the chat
// rendered "[空消息]".
//
// Fix: c2c file segments are split out at the OneBot layer in
// `sendPrivateMessage` and dispatched through `bridge.sendC2cFileMessage`
// (which writes `RichText.notOnlineFile`, the correct wire slot for
// c2c files). Matches NapCat's `SendMsg.ts:404-415` which splits
// FILE / VIDEO / ARK / PTT into their own sendMsg calls and never
// mixes them with the regular elems[] batch.

import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { OneBotInstanceContext } from '../src/instance-context';
import { sendPrivateMessage } from '../src/modules/message-actions';

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
    messageStore: { findEvent: () => null } as any,
    cacheMessageMeta: vi.fn(),
    mediaStore: {} as any,
    musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
}

const goodReceipt = {
  messageId: 1, sequence: 100, clientSequence: 0, random: 1, timestamp: 1700000000,
};

describe('send_private_msg with {type:"file"} segment', () => {
  it('file-only message routes through sendC2cFileMessage (not sendPrivateMessage)', async () => {
    // Pure-file case — the elems[] path would have dropped this entirely
    // and shipped "[空消息]". The c2c file route must take over.
    const sendPrivateMessage_bridge = vi.fn();
    const sendC2cFileMessage = vi.fn(async (_uin: number, _uid: string, _info: any) => goodReceipt);
    const resolveUserUid = vi.fn(async () => 'u_peer');
    const recallUploadedFile = vi.fn(() => undefined);
    const bridge = fakeBridge({
      apis: { message: { sendPrivate: sendPrivateMessage_bridge, sendC2cFile: sendC2cFileMessage } } as any,
      resolveUserUid,
      recallUploadedFile,
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [{
      type: 'file',
      data: { file_id: 'uuid-abc', name: 'doc.txt', size: 123, md5: '00112233' },
    }] as any, false);

    expect(sendC2cFileMessage).toHaveBeenCalledOnce();
    expect(sendPrivateMessage_bridge).not.toHaveBeenCalled();

    const [uin, uid, info] = sendC2cFileMessage.mock.calls[0]!;
    expect(uin).toBe(67890);
    expect(uid).toBe('u_peer');
    expect(info).toMatchObject({
      fileId: 'uuid-abc',
      fileName: 'doc.txt',
      fileSize: 123,
    });
    // md5 decoded from hex (4 bytes for '00112233')
    expect(info.fileMd5).toEqual(Buffer.from('00112233', 'hex'));
  });

  it('file-only with just file_id hydrates fileName/size/md5 from the upload cache', async () => {
    // Reproduces the "0 B file" bug: a caller passes only `file_id` from
    // a previous upload_private_file, with no size/md5/name. Without
    // the cache lookup the wire packet ships fileSize=0/md5=empty and
    // the recipient sees a 0-byte file. With the cache we recover the
    // real tuple.
    const sendC2cFileMessage = vi.fn(async (_uin: number, _uid: string, _info: any) => goodReceipt);
    const recallUploadedFile = vi.fn((id: string) => id === 'uuid-cached' ? {
      fileId: 'uuid-cached',
      scope: 'private' as const,
      userId: 67890,
      fileName: 'real-doc.pdf',
      fileSize: 4096,
      fileMd5: Buffer.from('aabbccddeeff', 'hex'),
      fileSha1: new Uint8Array(20),
      fileHash: 'srv-hash',
      rememberedAt: 0,
    } : undefined);
    const bridge = fakeBridge({
      apis: { message: { sendPrivate: vi.fn(), sendC2cFile: sendC2cFileMessage } } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
      recallUploadedFile,
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [{
      type: 'file', data: { file_id: 'uuid-cached' },
    }] as any, false);

    expect(sendC2cFileMessage).toHaveBeenCalledOnce();
    const [, , info] = sendC2cFileMessage.mock.calls[0]!;
    expect(info).toMatchObject({
      fileId: 'uuid-cached',
      fileName: 'real-doc.pdf',
      fileSize: 4096,
      fileHash: 'srv-hash',
    });
    expect(info.fileMd5).toEqual(Buffer.from('aabbccddeeff', 'hex'));
  });

  it('inline segment fields take precedence over the upload cache', async () => {
    // If the caller threads the metadata inline (e.g. they tracked the
    // upload response themselves), honour that over the cache so a
    // refresh of an evicted file still works.
    const sendC2cFileMessage = vi.fn(async (_uin: number, _uid: string, _info: any) => goodReceipt);
    const recallUploadedFile = vi.fn(() => ({
      fileId: 'uuid-x',
      scope: 'private' as const,
      userId: 67890,
      fileName: 'stale-cache-name.txt',
      fileSize: 99,
      fileMd5: new Uint8Array(16),
      fileSha1: new Uint8Array(20),
      fileHash: 'stale-hash',
      rememberedAt: 0,
    }));
    const bridge = fakeBridge({
      apis: { message: { sendPrivate: vi.fn(), sendC2cFile: sendC2cFileMessage } } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
      recallUploadedFile,
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [{
      type: 'file', data: { file_id: 'uuid-x', name: 'inline.txt', size: 200, md5: '11223344', file_hash: 'inline-hash' },
    }] as any, false);

    const [, , info] = sendC2cFileMessage.mock.calls[0]!;
    expect(info).toMatchObject({
      fileName: 'inline.txt',
      fileSize: 200,
      fileHash: 'inline-hash',
    });
    expect(info.fileMd5).toEqual(Buffer.from('11223344', 'hex'));
  });

  it('mixed file + text splits across two sends (text first, file second)', async () => {
    const sendPrivateMessage_bridge = vi.fn(async (_uin: number, _elements: any[]) => goodReceipt);
    const sendC2cFileMessage = vi.fn(async (_uin: number, _uid: string, _info: any) => goodReceipt);
    const resolveUserUid = vi.fn(async () => 'u_peer');
    const bridge = fakeBridge({
      apis: { message: { sendPrivate: sendPrivateMessage_bridge, sendC2cFile: sendC2cFileMessage } } as any,
      resolveUserUid,
      recallUploadedFile: vi.fn(() => undefined),
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [
      { type: 'text', data: { text: 'here is the file:' } },
      { type: 'file', data: { file_id: 'uuid-xyz', name: 'pkg.zip' } },
    ] as any, false);

    expect(sendPrivateMessage_bridge).toHaveBeenCalledOnce();
    expect(sendC2cFileMessage).toHaveBeenCalledOnce();

    // Text goes via the elems[] pipeline.
    const [textUin, textElements] = sendPrivateMessage_bridge.mock.calls[0]!;
    expect(textUin).toBe(67890);
    expect(textElements).toEqual([{ type: 'text', text: 'here is the file:' }]);

    // File goes via the dedicated c2c-file API.
    const [fileUin, fileUid, fileInfo] = sendC2cFileMessage.mock.calls[0]!;
    expect(fileUin).toBe(67890);
    expect(fileUid).toBe('u_peer');
    expect(fileInfo).toMatchObject({ fileId: 'uuid-xyz', fileName: 'pkg.zip' });
  });

  it('file segment without file_id is skipped (with a warn-level log)', async () => {
    // OneBot11 file segments are upload-by-reference — without a
    // file_id there's nothing to send. Previously these slipped
    // through to the elems[] path and shipped empty messages.
    const sendPrivateMessage_bridge = vi.fn(async (_uin: number, _elements: any[]) => goodReceipt);
    const sendC2cFileMessage = vi.fn();
    const bridge = fakeBridge({
      apis: { message: { sendPrivate: sendPrivateMessage_bridge, sendC2cFile: sendC2cFileMessage } } as any,
      resolveUserUid: vi.fn(),
      recallUploadedFile: vi.fn(() => undefined),
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [
      { type: 'text', data: { text: 'with bad file segment' } },
      { type: 'file', data: {} }, // no file_id
    ] as any, false);

    // Text still went out, file dropped (no c2c file call).
    expect(sendPrivateMessage_bridge).toHaveBeenCalledOnce();
    expect(sendC2cFileMessage).not.toHaveBeenCalled();
  });

  it('throws when uid cannot be resolved for a file-only message', async () => {
    // C2C file send requires the recipient's UID for the RichText.
    // notOnlineFile routing. If lookup fails we can't proceed —
    // surfacing the error is better than shipping a c2c send with
    // an empty uid.
    const sendC2cFileMessage = vi.fn();
    const bridge = fakeBridge({
      apis: { message: { sendPrivate: vi.fn(), sendC2cFile: sendC2cFileMessage } } as any,
      resolveUserUid: vi.fn(async () => ''), // intentional empty
      recallUploadedFile: vi.fn(() => undefined),
    } as any);
    const ctx = makeCtx(bridge);

    await expect(sendPrivateMessage(ctx, 67890, [
      { type: 'file', data: { file_id: 'uuid-orphan', name: 'x.txt' } },
    ] as any, false)).rejects.toThrow(/could not resolve uid/);

    expect(sendC2cFileMessage).not.toHaveBeenCalled();
  });

  it('file segment with url (no file_id) auto-uploads via groupFile.uploadPrivate (not sendC2cFile)', async () => {
    // uploadPrivate() internally calls sendC2cFile() — must NOT call it again.
    const uploadPrivate = vi.fn(async (_uid: number, _src: string, _name: string, _doUpload: boolean) =>
      ({ fileId: 'auto-fid', fileHash: null }));
    const sendC2cFileMessage = vi.fn();
    const bridge = fakeBridge({
      apis: {
        message: { sendPrivate: vi.fn(), sendC2cFile: sendC2cFileMessage },
        groupFile: { uploadPrivate },
      } as any,
      resolveUserUid: vi.fn(async () => 'u_peer'),
      recallUploadedFile: vi.fn(() => undefined),
    } as any);
    const ctx = makeCtx(bridge);

    await sendPrivateMessage(ctx, 67890, [{
      type: 'file', data: { file: '/tmp/audio.wav', name: 'audio.wav' },
    }] as any, false);

    expect(uploadPrivate).toHaveBeenCalledOnce();
    const [uid, src, name, doUpload] = uploadPrivate.mock.calls[0]!;
    expect(uid).toBe(67890);
    expect(src).toBe('/tmp/audio.wav');
    expect(name).toBe('audio.wav');
    expect(doUpload).toBe(true);
    // sendC2cFile must NOT be called — uploadPrivate() handles it internally
    expect(sendC2cFileMessage).not.toHaveBeenCalled();
  });
});
