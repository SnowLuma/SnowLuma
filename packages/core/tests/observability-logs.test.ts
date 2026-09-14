// Tests for the new PR5 observability log lines:
//   - [Highway.Image] entry log on uploadImageMsgInfo
//   - [Highway] fast-upload hit when OIDB returns no uKey
//   - [Highway] OIDB-requires-bytes + PUT-done with elapsed ms
//   - [MsgPush.Unknown] unrecognized PkgType
//   - [MsgPush.Unknown] wrapper decoder unknown subType
//
// Highway transport is mocked the same way pipeline.test.ts does it so
// runNtv2Upload exercises real OIDB encode/decode but skips actual
// network I/O.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';

vi.mock('@snowluma/protocol/highway', () => ({
  fetchHighwaySession: vi.fn(async () => ({ sessionId: 'fake-session' })),
  uploadHighwayHttp: vi.fn(async () => undefined),
  buildHighwayExtend: vi.fn(() => new Uint8Array([0xAA, 0xBB])),
  BufferChunkSource: class BufferChunkSource { constructor(readonly bytes: Uint8Array) {} },
  PRIVATE_IMAGE_CMD_ID: 1003,
  GROUP_IMAGE_CMD_ID: 1004,
}));

import {
  runNtv2Upload,
  type MediaSubFileUpload,
} from '@snowluma/protocol/highway/pipeline';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2UploadRichMediaResp } from '@snowluma/proto-defs/highway';
import { MsgPushRegistry } from '@snowluma/protocol/msg-push/registry';
import type { MsgPushContext } from '@snowluma/protocol/msg-push/context';
import { decodeEvent0x2DC } from '@snowluma/protocol/msg-push/decoders/event-0x2dc';

function encodeOidbResponse(body: unknown): Buffer {
  return Buffer.from(protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({
    command: 0x11C4, subCommand: 100, errorCode: 0,
    body: body as Record<string, unknown>,
    errorMsg: '', reserved: 1,
  } as OidbBase<NTV2UploadRichMediaResp>));
}

function fakeBridge(responseData: Buffer, uin = '12345'): any {
  return {
    identity: { uin },
    sendRawPacket: vi.fn(async () => ({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData,
    })),
  };
}

let captured: LogEntry[];
let unsub: () => void;

beforeEach(() => {
  captured = [];
  unsub = subscribeLogs((e) => captured.push(e));
});

afterEach(() => {
  unsub();
});

describe('PR5 — highway pipeline logging', () => {
  it('logs fast-upload hit when the server returns no uKey', async () => {
    // upload.uKey absent → no PUT performed.
    const bridge = fakeBridge(encodeOidbResponse({
      upload: { msgInfo: { msgInfoBody: [], extBizInfo: {} } },
    }));

    const params = {
      bridge,
      isGroup: true,
      targetIdOrUid: 67890,
      oidbCmd: 0x11C4,
      serviceCmd: 'OidbSvcTrpcTcp.0x11c4_100',
      requestId: 1,
      businessType: 1,
      uploadInfo: [{ fileInfo: { fileName: 'a.jpg' }, subFileType: 0 }],
      compatQmsgSceneType: 2,
      extBizInfo: { pic: {} },
      uploads: [{
        source: 'top',
        cmdId: 1004,
        bytes: new Uint8Array([1, 2, 3]),
        md5: new Uint8Array(16),
        sha1: new Uint8Array(20),
      }] as MediaSubFileUpload[],
      label: 'image',
    };

    await runNtv2Upload(params);

    const hit = captured.find((e) =>
      e.scope === 'Highway' && e.message.includes('fast-upload hit'));
    expect(hit).toBeDefined();
    expect(hit!.uin).toBe(12345);
  });

  it('logs OIDB-requires-bytes and PUT-done with elapsed ms when uKey is present', async () => {
    const bridge = fakeBridge(encodeOidbResponse({
      upload: {
        uKey: 'server-needs-bytes-please',
        ipv4s: [{ ipv4: '1.2.3.4', port: 80 }],
        msgInfo: { msgInfoBody: [], extBizInfo: {} },
      },
    }));

    const params = {
      bridge,
      isGroup: true,
      targetIdOrUid: 67890,
      oidbCmd: 0x11C4,
      serviceCmd: 'OidbSvcTrpcTcp.0x11c4_100',
      requestId: 1,
      businessType: 1,
      uploadInfo: [{ fileInfo: { fileName: 'a.jpg' }, subFileType: 0 }],
      compatQmsgSceneType: 2,
      extBizInfo: { pic: {} },
      uploads: [{
        source: 'top',
        cmdId: 1004,
        bytes: new Uint8Array(1024),
        md5: new Uint8Array(16),
        sha1: new Uint8Array(20),
      }] as MediaSubFileUpload[],
      label: 'image',
    };

    await runNtv2Upload(params);

    const requiresBytes = captured.find((e) =>
      e.scope === 'Highway' && e.message.includes('OIDB requires bytes'));
    const putDone = captured.find((e) =>
      e.scope === 'Highway' && /PUT done in \d+ms/.test(e.message));

    expect(requiresBytes).toBeDefined();
    expect(putDone).toBeDefined();

    const fastHit = captured.find((e) =>
      e.scope === 'Highway' && e.message.includes('fast-upload hit'));
    expect(fastHit).toBeUndefined();
  });
});

describe('PR5 — MsgPush unknown dispatch logging', () => {
  it('logs an unknown PkgType under [MsgPush.Unknown]', () => {
    const reg = new MsgPushRegistry();
    // No decoders registered → any pkgType is unknown.
    const ctx = {
      head: { msgType: 9999, subType: 0, timestamp: 0 },
      content: new Uint8Array(0),
      identity: {} as any,
      fromUin: 0,
      selfUin: 0,
    } as unknown as MsgPushContext;

    reg.decode(ctx);

    const entry = captured.find((e) =>
      e.scope === 'MsgPush.Unknown' && e.message.includes('PkgType=9999'));
    expect(entry).toBeDefined();
    expect(entry!.level).toBe('debug');
  });

  it('logs an unknown wrapper subType under [MsgPush.Unknown] (Event0x2DC)', () => {
    const ctx = {
      head: { msgType: 732, subType: 999, timestamp: 0 },
      content: new Uint8Array(0),
      identity: {} as any,
      fromUin: 0,
      selfUin: 0,
    } as unknown as MsgPushContext;

    decodeEvent0x2DC(ctx);

    const entry = captured.find((e) =>
      e.scope === 'MsgPush.Unknown' && /Event0x2DC unknown subType=999/.test(e.message));
    expect(entry).toBeDefined();
    expect(entry!.level).toBe('debug');
  });
});
