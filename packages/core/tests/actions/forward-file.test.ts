// Regression coverage for the file-inside-send_forward_msg bug.
//
// Symptom: caller put `{type:'file', file_id}` inside a forward node;
// the element-builder dropped it (`[ElemBuilder] BUG: {type:"file"}
// reached element-builder — must be split out at the OneBot layer`)
// because the live-send paths route files through dedicated methods
// (sendC2cFileMessage / sendGroupFileMessage), and the forward
// builder was naïvely calling buildSendElems with the same ctx. The
// forward upload succeeded but the bubble shipped without the file
// element.
//
// Fix: forward upload passes `forwardFake: true` on the SendContext.
// The element-builder honours that flag by emitting the receive-side
// shapes:
//   * group file → transElem(elemType=24, GroupFileExtra)
//   * c2c file   → handled at the forward-builder level, written into
//                  `body.msgContent` as FileExtra { file: NotOnlineFile }
//
// These shapes are RECEIVE-side: the QQ-NT live-send pipeline rejects
// transElem(24) (result=79), but the long-msg upload service stores the
// gzipped protobuf verbatim and the recipient's msg-push decoder pulls
// the file entity back out via the normal path (rich-body-decoder.ts).
// Mirrors NapCat's `PacketMsgFileElement.{buildElement,buildContent}`
// split.

import { describe, it, expect, vi } from 'vitest';
import { gunzipSync } from 'zlib';

vi.mock('@snowluma/protocol/bridge-oidb', () => ({
  runOidb: vi.fn(async () => new Uint8Array()),
  makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  encodeOidbEnv: vi.fn(() => new Uint8Array()),
  decodeOidbEnv: vi.fn(() => ({ body: {} })),
}));

// `vi.mock` factories are hoisted above the imports — declare the spy
// inside a `vi.hoisted` block so it's available at the same moment.
// Declare parameter types on the fn so `mock.calls[0]` infers a tuple
// of [elements, ctx] instead of `[]`, which makes the destructuring
// a tsc error under strict tuple checking on CI.
const { buildSendElemsMock } = vi.hoisted(() => ({
  buildSendElemsMock: vi.fn(async (_elements: unknown[], _ctx?: Record<string, unknown>) => []),
}));
vi.mock('@snowluma/protocol/element-builder', () => ({
  buildSendElems: buildSendElemsMock,
}));

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { LongMsgResult, SendLongMsgReq, SendLongMsgResp } from '@snowluma/proto-defs/longmsg';
import type { FileExtra } from '@snowluma/proto-defs/message';
import { ForwardApi } from '../../src/bridge/apis/forward';
import { mockBridge } from './_helpers';

function uploadResponseWithResId(resId: string) {
  const encoded = protobuf_encode<SendLongMsgResp>({ result: { resId } });
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(encoded),
  };
}

function decodeLongMsgRequest(rawBytes: Uint8Array): LongMsgResult {
  const env = protobuf_decode<SendLongMsgReq>(rawBytes);
  const payload = env.info?.payload;
  if (!(payload instanceof Uint8Array)) throw new Error('payload missing on SendLongMsgReq');
  return protobuf_decode<LongMsgResult>(gunzipSync(Buffer.from(payload)));
}

describe('actions/forward — file segment inside forward node', () => {
  it('group forward sets forwardFake:true on the SendContext so transElem(24) is emitted', async () => {
    // Group case: the file element rides on elems[] as transElem(24).
    // The element-builder receives ctx.forwardFake=true so it knows to
    // emit the receive-side shape instead of dropping the segment.
    buildSendElemsMock.mockClear();
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-grp-file')) as any,
    });

    await new ForwardApi(bridge as any).upload([
      {
        userUin: 10001,
        nickname: 'alice',
        elements: [{ type: 'file', fileId: 'gfid-1', fileName: 'a.txt', fileSize: 99 } as any],
      },
    ], 12345);

    expect(buildSendElemsMock).toHaveBeenCalled();
    const [, ctx] = buildSendElemsMock.mock.calls[0]!;
    expect(ctx).toMatchObject({ groupId: 12345, forwardFake: true });
  });

  it('c2c forward writes the file as msgContent (FileExtra { file: NotOnlineFile })', async () => {
    // Private case: c2c files live on `body.msgContent`, not in elems[].
    // The forward-builder pulls the file segment off and synthesises a
    // FileExtra payload so the recipient's decoder (which reads
    // msgContent first) renders the file bubble.
    buildSendElemsMock.mockClear();
    let captured: Uint8Array | undefined;
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async (_cmd: string, body: Uint8Array) => {
        captured = body;
        return uploadResponseWithResId('res-c2c-file');
      }) as any,
      // Inline fields cover everything we need; cache lookup must not be
      // required for the path to work.
      recallUploadedFile: vi.fn(() => undefined),
    });

    await new ForwardApi(bridge as any).upload([
      {
        userUin: 10001,
        nickname: 'alice',
        elements: [{
          type: 'file',
          fileId: 'pfid-1',
          fileName: 'invoice.pdf',
          fileSize: 4096,
          md5Hex: 'aabbccddeeff00112233445566778899',
          fileHash: 'srv-hash-abc',
        } as any],
      },
    ], undefined, 67890);

    expect(buildSendElemsMock).toHaveBeenCalled();
    const [, ctx] = buildSendElemsMock.mock.calls[0]!;
    expect(ctx).toMatchObject({ forwardFake: true });
    expect(ctx?.groupId).toBeUndefined();

    expect(captured).toBeDefined();
    const longMsg = decodeLongMsgRequest(captured!);
    const body = longMsg.action?.[0]?.actionData?.msgBody?.[0]?.body;
    expect(body?.msgContent).toBeInstanceOf(Uint8Array);
    expect(body?.richText?.notOnlineFile ?? undefined).toBeUndefined();

    const fileExtra = protobuf_decode<FileExtra>(body!.msgContent as Uint8Array);
    expect(fileExtra.file).toMatchObject({
      fileUuid: 'pfid-1',
      fileName: 'invoice.pdf',
      fileHash: 'srv-hash-abc',
    });
    expect(fileExtra.file?.fileSize).toBe(4096n);
  });

  it('c2c forward falls back to the upload metadata cache when inline fields are missing', async () => {
    // The OneBot caller often passes only `file_id` — the rest comes
    // from the bridge's uploaded-file cache. This is the same
    // hydration path send_private_msg uses; the forward builder must
    // honour it too or every cached-only forward ships a 0 B bubble.
    buildSendElemsMock.mockClear();
    const recallUploadedFile = vi.fn((id: string) => id === 'pfid-cached' ? {
      fileId: 'pfid-cached',
      scope: 'private' as const,
      userId: 67890,
      fileName: 'cached-name.zip',
      fileSize: 8192,
      fileMd5: Buffer.from('ffeeddccbbaa99887766554433221100', 'hex'),
      fileSha1: new Uint8Array(20),
      fileHash: 'cached-hash',
      rememberedAt: 0,
    } : undefined);

    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-cache')) as any,
      recallUploadedFile,
    });

    await new ForwardApi(bridge as any).upload([{
      userUin: 10001,
      nickname: 'alice',
      elements: [{ type: 'file', fileId: 'pfid-cached' } as any],
    }], undefined, 67890);

    expect(recallUploadedFile).toHaveBeenCalledWith('pfid-cached');
  });

  it('group forward pre-uploads file sources into the target group without publishing a separate file message', async () => {
    buildSendElemsMock.mockClear();
    const upload = vi.fn(async () => ({ fileId: 'gfid-from-base64' }));
    const publish = vi.fn();
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-grp-source')) as any,
      apis: {
        ...mockBridge().apis,
        groupFile: {
          ...mockBridge().apis.groupFile,
          upload,
          publish,
        },
      },
      recallUploadedFile: vi.fn((id: string) => id === 'gfid-from-base64' ? {
        fileId: 'gfid-from-base64',
        scope: 'group' as const,
        groupId: 12345,
        fileName: 'note.txt',
        fileSize: 3,
        fileMd5: new Uint8Array(16),
        fileSha1: new Uint8Array(20),
        rememberedAt: 0,
      } : undefined),
    });

    await new ForwardApi(bridge as any).upload([{
      userUin: 10001,
      nickname: 'alice',
      elements: [{ type: 'file', url: 'base64://AQID', fileName: 'note.txt' } as any],
    }], 12345);

    expect(upload).toHaveBeenCalledWith(12345, 'base64://AQID', 'note.txt', '/', true, false);
    expect(publish).not.toHaveBeenCalled();
    const [elements] = buildSendElemsMock.mock.calls[0]!;
    expect(elements).toEqual([expect.objectContaining({
      type: 'file',
      fileId: 'gfid-from-base64',
      fileName: 'note.txt',
      fileSize: 3,
    })]);
  });

  it('private forward pre-uploads file sources without sending a standalone c2c file message', async () => {
    buildSendElemsMock.mockClear();
    const uploadPrivate = vi.fn(async () => ({ fileId: 'pfid-from-base64', fileHash: 'phash' }));
    const sendC2cFile = vi.fn();
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-c2c-source')) as any,
      apis: {
        ...mockBridge().apis,
        message: {
          ...mockBridge().apis.message,
          sendC2cFile,
        },
        groupFile: {
          ...mockBridge().apis.groupFile,
          uploadPrivate,
        },
      },
      recallUploadedFile: vi.fn((id: string) => id === 'pfid-from-base64' ? {
        fileId: 'pfid-from-base64',
        scope: 'private' as const,
        userId: 67890,
        fileName: 'note.txt',
        fileSize: 3,
        fileMd5: new Uint8Array(16),
        fileSha1: new Uint8Array(20),
        fileHash: 'phash',
        rememberedAt: 0,
      } : undefined),
    });

    await new ForwardApi(bridge as any).upload([{
      userUin: 10001,
      nickname: 'alice',
      elements: [{ type: 'file', url: 'base64://AQID', fileName: 'note.txt' } as any],
    }], undefined, 67890);

    expect(uploadPrivate).toHaveBeenCalledWith(67890, 'base64://AQID', 'note.txt', true, false);
    expect(sendC2cFile).not.toHaveBeenCalled();
    const [elements] = buildSendElemsMock.mock.calls[0]!;
    expect(elements).toEqual([expect.objectContaining({
      type: 'file',
      fileId: 'pfid-from-base64',
      fileName: 'note.txt',
      fileSize: 3,
      fileHash: 'phash',
    })]);
  });

  it('private file forward keeps the long-msg upload under the self uid namespace', async () => {
    buildSendElemsMock.mockClear();
    let captured: Uint8Array | undefined;
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async (_cmd: string, body: Uint8Array) => {
        captured = body;
        return uploadResponseWithResId('res-c2c-target-uid');
      }) as any,
      resolveUserUid: vi.fn(async () => 'target-uid'),
      recallUploadedFile: vi.fn((id: string) => id === 'pfid-1' ? {
        fileId: 'pfid-1',
        scope: 'private' as const,
        userId: 67890,
        fileName: 'invoice.pdf',
        fileSize: 4096,
        fileMd5: new Uint8Array(16),
        fileSha1: new Uint8Array(20),
        fileHash: 'srv-hash',
        rememberedAt: 0,
      } : undefined),
    });

    await new ForwardApi(bridge as any).upload([{
      userUin: 10001,
      nickname: 'alice',
      elements: [{ type: 'file', fileId: 'pfid-1' } as any],
    }], undefined, 67890);

    expect(bridge.resolveUserUid).not.toHaveBeenCalled();
    expect(captured).toBeDefined();
    const request = protobuf_decode<SendLongMsgReq>(captured!);
    expect(request.info?.uid?.uid).toBe('self-uid');
  });

  it('group forward re-uploads a cached private file_id into the target group scope', async () => {
    buildSendElemsMock.mockClear();
    const getPrivateUrl = vi.fn(async () => 'https://download.test/private-file');
    const upload = vi.fn(async () => ({ fileId: 'gfid-reuploaded' }));
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-cross-scope')) as any,
      apis: {
        ...mockBridge().apis,
        groupFile: {
          ...mockBridge().apis.groupFile,
          getPrivateUrl,
          upload,
        },
      },
      recallUploadedFile: vi.fn((id: string) => {
        if (id === 'pfid-cached') {
          return {
            fileId: 'pfid-cached',
            scope: 'private' as const,
            userId: 67890,
            fileName: 'cached.txt',
            fileSize: 5,
            fileMd5: new Uint8Array(16),
            fileSha1: new Uint8Array(20),
            fileHash: 'cached-hash',
            rememberedAt: 0,
          };
        }
        if (id === 'gfid-reuploaded') {
          return {
            fileId: 'gfid-reuploaded',
            scope: 'group' as const,
            groupId: 12345,
            fileName: 'cached.txt',
            fileSize: 5,
            fileMd5: new Uint8Array(16),
            fileSha1: new Uint8Array(20),
            rememberedAt: 1,
          };
        }
        return undefined;
      }),
    });

    await new ForwardApi(bridge as any).upload([{
      userUin: 10001,
      nickname: 'alice',
      elements: [{ type: 'file', fileId: 'pfid-cached' } as any],
    }], 12345);

    expect(getPrivateUrl).toHaveBeenCalledWith(67890, 'pfid-cached', 'cached-hash');
    expect(upload).toHaveBeenCalledWith(12345, 'https://download.test/private-file', 'cached.txt', '/', true, false);
    const [elements] = buildSendElemsMock.mock.calls[0]!;
    expect(elements).toEqual([expect.objectContaining({
      type: 'file',
      fileId: 'gfid-reuploaded',
      fileName: 'cached.txt',
      fileSize: 5,
    })]);
  });
});
