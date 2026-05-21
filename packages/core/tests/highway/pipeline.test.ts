// Pipeline tests: runNtv2Upload + finalizeMediaMsgInfo.
//
// Highway transport (fetchHighwaySession / uploadHighwayHttp /
// buildHighwayExtend) is mocked so tests run without a real session.
// The OIDB response is built with real protobuf encoding so we exercise
// the actual decode path inside the pipeline.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

vi.mock('@snowluma/bridge/highway', () => ({
  fetchHighwaySession: vi.fn(async () => ({ sessionId: 'fake-session' })),
  uploadHighwayHttp: vi.fn(async () => undefined),
  buildHighwayExtend: vi.fn(() => new Uint8Array([0xAA, 0xBB])),
  PRIVATE_IMAGE_CMD_ID: 1003,
  GROUP_IMAGE_CMD_ID: 1004,
}));

import * as highway from '@snowluma/bridge/highway';
import {
  finalizeMediaMsgInfo,
  hexToBytes,
  makeClientRandomId,
  runNtv2Upload,
  type MediaSubFileUpload,
} from '@snowluma/bridge/highway/pipeline';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { EncodableMediaMsgInfo, NTV2UploadRichMediaReq, NTV2UploadRichMediaResp } from '@snowluma/proto-defs/highway';

interface FakeUploadResponse {
  upload?: {
    uKey?: string;
    ipv4s?: Array<{ ipv4?: string; port?: number }>;
    msgInfo?: {
      msgInfoBody?: Array<Record<string, unknown>>;
      extBizInfo?: Record<string, unknown>;
    };
    subFileInfos?: Array<{
      uKey?: string;
      ipv4s?: Array<{ ipv4?: string; port?: number }>;
    }>;
  };
  respHead?: { retCode?: number; message?: string };
}

function encodeOidbResponse(body: FakeUploadResponse, opts: { errorCode?: number; errorMsg?: string } = {}): Buffer {
  return Buffer.from(protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({
    command: 0x11C4,
    subCommand: 100,
    errorCode: opts.errorCode ?? 0,
    // The OIDB base schema types `body` as a generic ProtoDecoded record;
    // the test shape is more specific, so we cast through unknown.
    body: body as unknown as Record<string, unknown>,
    errorMsg: opts.errorMsg ?? '',
    reserved: 1,
  } as OidbBase<NTV2UploadRichMediaResp>));
}

type SendPacketResult = {
  success: boolean;
  gotResponse: boolean;
  errorCode: number;
  errorMessage: string;
  responseData: Buffer | null;
};

function makeBridge(opts: {
  responseData?: Buffer | null;
  success?: boolean;
  errorMessage?: string;
} = {}) {
  // Explicit two-arg signature so `mock.calls[0]` typechecks as
  // [string, Uint8Array] rather than the inferred empty tuple.
  const sendRawPacket = vi.fn<(cmd: string, body: Uint8Array) => Promise<SendPacketResult>>(
    async () => ({
      success: opts.success ?? true,
      gotResponse: opts.responseData !== null,
      errorCode: 0,
      errorMessage: opts.errorMessage ?? '',
      responseData: opts.responseData ?? Buffer.alloc(0),
    }),
  );
  return { sendRawPacket };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    bridge: makeBridge() as any,
    isGroup: true,
    targetIdOrUid: 12345,
    oidbCmd: 0x11C4,
    serviceCmd: 'OidbSvcTrpcTcp.0x11c4_100',
    requestId: 1,
    businessType: 1,
    uploadInfo: [{ fileInfo: { fileName: 'a.jpg' }, subFileType: 0 }],
    compatQmsgSceneType: 2,
    extBizInfo: { pic: {} },
    uploads: [] as MediaSubFileUpload[],
    ...overrides,
  };
}

describe('pipeline — runNtv2Upload', () => {
  beforeEach(() => {
    vi.mocked(highway.fetchHighwaySession).mockClear();
    vi.mocked(highway.uploadHighwayHttp).mockClear();
    vi.mocked(highway.buildHighwayExtend).mockClear();
  });

  it('builds an NTV2 request body and dispatches to the configured serviceCmd', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({ upload: { msgInfo: { msgInfoBody: [], extBizInfo: {} } } }),
    });
    await runNtv2Upload(baseParams({ bridge }));

    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    const [serviceCmd, requestBytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('OidbSvcTrpcTcp.0x11c4_100');
    expect((requestBytes as Uint8Array).length).toBeGreaterThan(0);

    // The request roundtrips through the real OIDB envelope and carries
    // the requestId / businessType / scene fields we passed.
    const decoded: any = protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(requestBytes as Uint8Array);
    expect(decoded.command).toBe(0x11C4);
    expect(decoded.body.reqHead.common.requestId).toBe(1);
    expect(decoded.body.reqHead.scene.businessType).toBe(1);
    expect(decoded.body.reqHead.scene.sceneType).toBe(2); // isGroup -> 2
    expect(decoded.body.reqHead.scene.group.groupUin).toBe(12345);
  });

  it('builds a c2c body when isGroup is false', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({ upload: { msgInfo: { msgInfoBody: [], extBizInfo: {} } } }),
    });
    await runNtv2Upload(baseParams({ bridge, isGroup: false, targetIdOrUid: 'recipient-uid' }));

    const requestBytes = bridge.sendRawPacket.mock.calls[0]![1];
    const decoded: any = protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(requestBytes as Uint8Array);
    expect(decoded.body.reqHead.scene.sceneType).toBe(1);
    expect(decoded.body.reqHead.scene.c2c.targetUid).toBe('recipient-uid');
  });

  it('returns the decoded `upload` object on success', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({
        upload: {
          uKey: 'fake-ukey',
          msgInfo: { msgInfoBody: [{ fileExist: true }], extBizInfo: {} },
        },
      }),
    });
    const upload = await runNtv2Upload(baseParams({ bridge }));
    expect(upload.uKey).toBe('fake-ukey');
    expect(upload.msgInfo.msgInfoBody).toHaveLength(1);
  });

  it('throws on transport failure', async () => {
    const bridge = makeBridge({ success: false, errorMessage: 'pipe broken', responseData: null });
    await expect(runNtv2Upload(baseParams({ bridge })))
      .rejects.toThrow(/pipe broken/);
  });

  it('throws on OIDB errorCode != 0', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({}, { errorCode: 42, errorMsg: 'boom' }),
    });
    await expect(runNtv2Upload(baseParams({ bridge })))
      .rejects.toThrow(/OIDB error 42/);
  });

  it('throws on body.respHead.retCode != 0', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({
        respHead: { retCode: 7, message: 'rate-limited' },
      }),
    });
    await expect(runNtv2Upload(baseParams({ bridge })))
      .rejects.toThrow(/rate-limited/);
  });

  it('throws "response body missing" when body.upload is absent', async () => {
    const bridge = makeBridge({ responseData: encodeOidbResponse({}) });
    await expect(runNtv2Upload(baseParams({ bridge, label: 'image' })))
      .rejects.toThrow(/image upload response body missing/);
  });

  it('does NOT run Highway PUT when the server omits uKey (fast-path)', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({
        upload: { msgInfo: { msgInfoBody: [], extBizInfo: {} } /* no uKey */ },
      }),
    });
    await runNtv2Upload(baseParams({
      bridge,
      uploads: [{
        source: 'top',
        cmdId: 1003,
        bytes: new Uint8Array([1, 2, 3]),
        md5: new Uint8Array(16),
        sha1: new Uint8Array(20),
      }],
    }));
    expect(highway.fetchHighwaySession).not.toHaveBeenCalled();
    expect(highway.uploadHighwayHttp).not.toHaveBeenCalled();
  });

  it('runs Highway PUT for the top-level uKey', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({
        upload: {
          uKey: 'ukey-xyz',
          ipv4s: [{ ipv4: '1.2.3.4', port: 8080 }],
          msgInfo: { msgInfoBody: [], extBizInfo: {} },
        },
      }),
    });
    await runNtv2Upload(baseParams({
      bridge,
      uploads: [{
        source: 'top',
        cmdId: 1003,
        bytes: new Uint8Array([1, 2, 3]),
        md5: new Uint8Array(16),
        sha1: new Uint8Array(20),
      }],
    }));
    expect(highway.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highway.buildHighwayExtend).toHaveBeenCalledOnce();
    expect(highway.uploadHighwayHttp).toHaveBeenCalledOnce();
  });

  it('routes sub-file uploads via upload.subFileInfos[N]', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({
        upload: {
          uKey: 'main-ukey',
          ipv4s: [{ ipv4: '1.1.1.1', port: 80 }],
          msgInfo: { msgInfoBody: [], extBizInfo: {} },
          subFileInfos: [
            { uKey: 'thumb-ukey', ipv4s: [{ ipv4: '2.2.2.2', port: 81 }] },
          ],
        },
      }),
    });
    await runNtv2Upload(baseParams({
      bridge,
      uploads: [
        { source: 'top', cmdId: 1001, bytes: new Uint8Array([1]), md5: new Uint8Array(16), sha1: new Uint8Array(20), subFileIndex: 0 },
        { source: 0, cmdId: 1002, bytes: new Uint8Array([2]), md5: new Uint8Array(16), sha1: new Uint8Array(20), subFileIndex: 1 },
      ],
    }));

    // Both Highway PUTs ran; only ONE Highway session was fetched.
    expect(highway.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highway.uploadHighwayHttp).toHaveBeenCalledTimes(2);
    expect(highway.buildHighwayExtend).toHaveBeenCalledTimes(2);

    // The two Highway PUTs received the right uKeys.
    const extendCalls = vi.mocked(highway.buildHighwayExtend).mock.calls;
    expect(extendCalls[0]![0]).toBe('main-ukey');
    expect(extendCalls[1]![0]).toBe('thumb-ukey');
  });

  it('throws fastOnlyError when uKey is present but bytes are empty', async () => {
    const bridge = makeBridge({
      responseData: encodeOidbResponse({
        upload: {
          uKey: 'ukey-xyz',
          msgInfo: { msgInfoBody: [], extBizInfo: {} },
        },
      }),
    });
    await expect(runNtv2Upload(baseParams({
      bridge,
      uploads: [{
        source: 'top',
        cmdId: 1003,
        bytes: new Uint8Array(0),
        md5: new Uint8Array(16),
        sha1: new Uint8Array(20),
        fastOnlyError: 'image fast-upload not available',
      }],
    }))).rejects.toThrow(/image fast-upload not available/);
  });

  it('silently skips a sub-file with empty bytes when no fastOnlyError is configured', async () => {
    // This mirrors the video-thumb path where bytes are always synthesised
    // (FALLBACK_THUMB) so we don't expect the check to fire even if the
    // server returns an empty thumb uKey alongside a present main uKey.
    const bridge = makeBridge({
      responseData: encodeOidbResponse({
        upload: {
          uKey: 'main-ukey',
          msgInfo: { msgInfoBody: [], extBizInfo: {} },
          subFileInfos: [{ uKey: 'thumb-ukey' }],
        },
      }),
    });
    await runNtv2Upload(baseParams({
      bridge,
      uploads: [
        { source: 'top', cmdId: 1001, bytes: new Uint8Array([1]), md5: new Uint8Array(16), sha1: new Uint8Array(20) },
        { source: 0, cmdId: 1002, bytes: new Uint8Array(0), md5: new Uint8Array(16), sha1: new Uint8Array(20) },
      ],
    }));
    expect(highway.uploadHighwayHttp).toHaveBeenCalledOnce(); // only main
  });
});

describe('pipeline — finalizeMediaMsgInfo', () => {
  it('throws when msgInfo is missing', () => {
    expect(() => finalizeMediaMsgInfo({})).toThrow(/missing msgInfo/);
  });

  it('encodes msgInfoBody + extBizInfo from the server response', () => {
    const out = finalizeMediaMsgInfo({
      msgInfo: {
        msgInfoBody: [{ index: { fileType: 1 }, fileExist: true }],
        extBizInfo: { busiType: 1 },
      },
    });
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBeGreaterThan(0);
  });

  it('with defaultPic, fills missing pic.bizType + pic.textSummary', () => {
    // Encode the result and decode it back via the same schema to inspect
    // what actually landed in the proto.
    const out = finalizeMediaMsgInfo({
      msgInfo: { msgInfoBody: [], extBizInfo: {} },
    }, { bizType: 7, textSummary: '[image]' });

    const decoded: any = protobuf_decode<EncodableMediaMsgInfo>(out);
    expect(decoded.extBizInfo.pic.bizType).toBe(7);
    expect(decoded.extBizInfo.pic.textSummary).toBe('[image]');
  });

  it('without defaultPic, leaves pic untouched when server omits it', () => {
    const out = finalizeMediaMsgInfo({
      msgInfo: { msgInfoBody: [], extBizInfo: {} },
    });
    const decoded: any = protobuf_decode<EncodableMediaMsgInfo>(out);
    // An empty extBizInfo proto roundtrips to undefined; either way the
    // pic field never got materialised.
    expect(decoded?.extBizInfo?.pic ?? undefined).toBeUndefined();
  });
});

describe('pipeline — helpers', () => {
  it('hexToBytes roundtrips even-length hex', () => {
    expect([...hexToBytes('deadbeef')]).toEqual([0xDE, 0xAD, 0xBE, 0xEF]);
  });

  it('hexToBytes left-pads odd-length hex with a leading zero', () => {
    expect([...hexToBytes('abc')]).toEqual([0x0A, 0xBC]);
  });

  it('makeClientRandomId produces a non-zero positive BigInt', () => {
    const id = makeClientRandomId();
    expect(typeof id).toBe('bigint');
    expect(id).toBeGreaterThan(0n);
    expect(id).toBeLessThan(0x8000000000000000n);
  });
});
