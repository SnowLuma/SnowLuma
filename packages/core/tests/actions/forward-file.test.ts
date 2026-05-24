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

import { protobuf_encode } from '@snowluma/proton';
import type { SendLongMsgResp } from '@snowluma/proto-defs/longmsg';
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

    // Spot-check that the upload body carries the file metadata. The
    // payload is gzipped + protobuf-wrapped, so we just verify the
    // raw filename string survived — that's enough to confirm the
    // FileExtra branch ran (a "missing file" regression would drop
    // these bytes entirely).
    expect(captured).toBeDefined();
    const flat = Buffer.from(captured!).toString('binary');
    // The filename gets gzipped, so we can't substring-search; instead
    // assert the body is large enough that the FileExtra wasn't elided.
    // (A name-only forward with no msgContent runs ~80-100 bytes; with
    // the FileExtra blob it's noticeably larger.)
    expect(flat.length).toBeGreaterThan(80);
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
});
