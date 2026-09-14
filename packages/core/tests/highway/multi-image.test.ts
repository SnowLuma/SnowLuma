// Regression test for the "two images in one message" bug user report.
//
// User saw: 1st image fast-uploaded (server already had the bytes), 2nd
// image triggered an actual highway PUT and the highway server returned
// `error_code=921`.
//
// This test walks two `runNtv2Upload` calls back-to-back through the
// real pipeline + buildHighwayExtend code path with the highway TCP/HTTP
// transport stubbed, and verifies:
//
//   - the two calls don't share state (each has its own session, its
//     own OIDB request, its own extend bytes),
//   - the second call's extend payload is well-formed (uKey + msgInfoBody
//     + ipv4s come from the *second* call's response, not the first),
//   - the highway PUT receives the second image's bytes + md5 + sha1
//     verbatim (no aliasing / truncation across calls).
//
// If this test ever starts failing, it's a real bug in the pipeline
// (state sharing, async race, or wrong-buffer aliasing). If it
// continues to pass, the user's 921 is almost certainly server-side
// (rate limit, malformed image rejection, expired session) rather than
// a client-emit issue.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

vi.mock('@snowluma/protocol/highway', async () => {
  const real = await vi.importActual<typeof import('@snowluma/protocol/highway')>('@snowluma/protocol/highway');
  return {
    ...real,
    // Only the TCP/HTTP transport is mocked — we keep real
    // `buildHighwayExtend` so we can inspect its output bytes.
    fetchHighwaySession: vi.fn(async () => ({
      sigSession: new Uint8Array([0xAA]),
      sessionKey: new Uint8Array([0xBB]),
      host: 'highway.example',
      port: 80,
    })),
    uploadHighwayHttp: vi.fn(async () => undefined),
  };
});

import * as highway from '@snowluma/protocol/highway';
import { runNtv2Upload, type MediaSubFileUpload } from '@snowluma/protocol/highway/pipeline';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  NTV2UploadRichMediaReq,
  NTV2UploadRichMediaResp,
  NTV2RichMediaHighwayExt,
} from '@snowluma/proto-defs/highway';

function encodeOidbResponse(body: any): Buffer {
  return Buffer.from(protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({
    command: 0x11C4, subCommand: 100, errorCode: 0,
    body: body as Record<string, unknown>, errorMsg: '', reserved: 1,
  }));
}

function makeBridge(responses: Buffer[]) {
  const sendRawPacket = vi.fn();
  for (const r of responses) {
    sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: r,
    });
  }
  return { sendRawPacket, identity: { uin: '10001' } } as any;
}

const baseParams = (bridge: any) => ({
  bridge, isGroup: true, targetIdOrUid: 894750076,
  oidbCmd: 0x11C4, serviceCmd: 'OidbSvcTrpcTcp.0x11c4_100',
  requestId: 1, businessType: 1,
  compatQmsgSceneType: 2,
  extBizInfo: { pic: { bizType: 0, textSummary: '[image]' } },
});

describe('runNtv2Upload — two images in one message (sequential)', () => {
  beforeEach(() => {
    vi.mocked(highway.fetchHighwaySession).mockClear();
    vi.mocked(highway.uploadHighwayHttp).mockClear();
  });

  it('does not leak the first image\'s upload metadata into the second\'s extend', async () => {
    // Image 1 server response: NO uKey (fast-upload hit). The pipeline
    // must skip the highway PUT entirely for this call.
    // Image 2 server response: uKey + ipv4s + msgInfoBody set → real PUT.
    const image1Bytes = Buffer.from(new Uint8Array(238963));
    const image1Md5 = new Uint8Array(16).fill(0xF4);
    const image2Bytes = Buffer.from(new Uint8Array(58));
    const image2Md5 = new Uint8Array(16).fill(0xDD);
    const image2Sha1 = new Uint8Array(20).fill(0x11);

    const bridge = makeBridge([
      // First OIDB upload response: fast-path hit (no uKey).
      encodeOidbResponse({
        upload: {
          msgInfo: {
            msgInfoBody: [{ index: { fileUuid: 'uuid-1' } }],
            extBizInfo: {},
          },
        },
      }),
      // Second OIDB upload response: needs highway PUT.
      encodeOidbResponse({
        upload: {
          uKey: 'ukey-image-2',
          ipv4s: [{ outIp: 0x04030201, outPort: 8080 }],
          msgInfo: {
            msgInfoBody: [{ index: { fileUuid: 'uuid-2', info: { fileHash: 'dd', fileSha1: '11' } } }],
            extBizInfo: {},
          },
        },
      }),
    ]);

    const uploads1: MediaSubFileUpload[] = [{
      source: 'top', cmdId: 1004,
      bytes: image1Bytes, md5: image1Md5, sha1: new Uint8Array(20).fill(0xAB),
      fastOnlyError: 'image fast-upload not available',
    }];
    const uploads2: MediaSubFileUpload[] = [{
      source: 'top', cmdId: 1004,
      bytes: image2Bytes, md5: image2Md5, sha1: image2Sha1,
      fastOnlyError: 'image fast-upload not available',
    }];

    // Image 1 — fast path; must NOT touch the highway transport.
    await runNtv2Upload({
      ...baseParams(bridge),
      uploadInfo: [{
        fileInfo: { fileName: 'a.jpg', fileSize: 238963 },
        subFileType: 0,
      }],
      uploads: uploads1,
      label: 'image',
    });
    expect(highway.fetchHighwaySession).not.toHaveBeenCalled();
    expect(highway.uploadHighwayHttp).not.toHaveBeenCalled();

    // Image 2 — must PUT through highway exactly once.
    await runNtv2Upload({
      ...baseParams(bridge),
      uploadInfo: [{
        fileInfo: { fileName: 'b.jpg', fileSize: 58 },
        subFileType: 0,
      }],
      uploads: uploads2,
      label: 'image',
    });
    expect(highway.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highway.uploadHighwayHttp).toHaveBeenCalledOnce();

    // The PUT receives image-2's bytes, image-2's md5, and the
    // image-2-derived extend (NOT image-1's data).
    const [, , cmdId, putSource, putMd5, putExtend] = vi.mocked(highway.uploadHighwayHttp).mock.calls[0]!;
    expect(cmdId).toBe(1004);
    // The PUT source is a ChunkSource wrapping image-2's bytes — verify it
    // yields image-2 exactly (not image-1) through its public read().
    expect(putSource.size).toBe(image2Bytes.length);
    expect(Buffer.from(await putSource.read(0, putSource.size)).equals(Buffer.from(image2Bytes))).toBe(true);
    expect(putMd5).toBe(image2Md5);

    // Decode the extend bytes; uKey + fileUuid must come from image-2's
    // response, ipv4s must come from image-2's response.
    const extend = protobuf_decode<NTV2RichMediaHighwayExt>(putExtend);
    expect(extend.uKey).toBe('ukey-image-2');
    expect(extend.fileUuid).toBe('uuid-2');
    expect(extend.msgInfoBody?.[0]?.index?.fileUuid).toBe('uuid-2');
    expect(extend.network?.ipv4s?.length).toBeGreaterThan(0);
  });

  it('image 2 fetches its own fresh session (no leftover from a prior call)', async () => {
    // Both images hit the highway PUT path. The pipeline must call
    // fetchHighwaySession once PER runNtv2Upload (not share session
    // across calls), matching NapCat's per-context lifetime semantics
    // would actually be a future optimisation, but for now correctness
    // = "session is non-null when PUT runs".
    const ok = encodeOidbResponse({
      upload: {
        uKey: 'ukey', ipv4s: [{ outIp: 1, outPort: 80 }],
        msgInfo: { msgInfoBody: [{ index: { fileUuid: 'u' } }], extBizInfo: {} },
      },
    });
    const bridge = makeBridge([ok, ok]);

    const uploads: MediaSubFileUpload[] = [{
      source: 'top', cmdId: 1004,
      bytes: Buffer.from([1, 2, 3]),
      md5: new Uint8Array(16), sha1: new Uint8Array(20),
      fastOnlyError: 'image fast-upload not available',
    }];

    await runNtv2Upload({
      ...baseParams(bridge),
      uploadInfo: [{ fileInfo: { fileName: 'a.jpg' }, subFileType: 0 }],
      uploads, label: 'image',
    });
    await runNtv2Upload({
      ...baseParams(bridge),
      uploadInfo: [{ fileInfo: { fileName: 'b.jpg' }, subFileType: 0 }],
      uploads, label: 'image',
    });

    expect(highway.fetchHighwaySession).toHaveBeenCalledTimes(2);
    expect(highway.uploadHighwayHttp).toHaveBeenCalledTimes(2);
    // The session object passed to the PUT must be non-null both times.
    for (const call of vi.mocked(highway.uploadHighwayHttp).mock.calls) {
      const session = call[1];
      expect(session).toBeDefined();
      expect((session as any).sigSession).toBeDefined();
    }
  });

  it('image 2\'s OIDB request body carries image-2\'s fileInfo (not image-1\'s)', async () => {
    // Catches a hypothetical bug where someone mutates a shared body
    // object across calls. Today the pipeline always builds a fresh
    // body, but the regression is cheap to guard.
    const ok = encodeOidbResponse({
      upload: { msgInfo: { msgInfoBody: [], extBizInfo: {} } },
    });
    const bridge = makeBridge([ok, ok]);

    await runNtv2Upload({
      ...baseParams(bridge),
      uploadInfo: [{ fileInfo: { fileName: 'first.jpg', fileSize: 100 }, subFileType: 0 }],
      uploads: [], label: 'image',
    });
    await runNtv2Upload({
      ...baseParams(bridge),
      uploadInfo: [{ fileInfo: { fileName: 'second.jpg', fileSize: 200 }, subFileType: 0 }],
      uploads: [], label: 'image',
    });

    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
    const body1 = protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(bridge.sendRawPacket.mock.calls[0]![1]);
    const body2 = protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(bridge.sendRawPacket.mock.calls[1]![1]);
    expect(body1.body?.upload?.uploadInfo?.[0]?.fileInfo?.fileName).toBe('first.jpg');
    expect(body2.body?.upload?.uploadInfo?.[0]?.fileInfo?.fileName).toBe('second.jpg');

    // And the clientRandomId is different per call (sanity).
    expect(body1.body?.upload?.clientRandomId).not.toBe(body2.body?.upload?.clientRandomId);
  });
});
