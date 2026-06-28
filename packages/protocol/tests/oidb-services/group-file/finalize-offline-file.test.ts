import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbOfflineFileFinalizeResp } from '@snowluma/proto-defs/oidb-actions/media';
import type { FileExtra } from '@snowluma/proto-defs/message';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FinalizeOfflineFile } from '../../../src/oidb-services/group-file/finalize-offline-file';
import { env, m, s, v } from '../_pb-oracle';

// `bytes` fields are wire type 2 — identical framing to a sub-message, so the
// oracle's `m()` (tag + length + payload) doubles as the bytes emitter.
const b = m;

function makeDeps(resp?: OidbOfflineFileFinalizeResp) {
  const responseData = resp !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbOfflineFileFinalizeResp>>({ body: resp }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FinalizeOfflineFile (0xE37_800)', () => {
  it('declares 0xE37_800', () => {
    expect(FinalizeOfflineFile.command).toBe(0xE37);
    expect(FinalizeOfflineFile.subCommand).toBe(800);
  });

  it('serializes the request body byte-for-byte (oracle locks every tag)', async () => {
    const deps = makeDeps({});
    await FinalizeOfflineFile.invoke(deps, {
      senderUid: 'su', receiverUid: 'ru', fileUuid: 'uuid', fileHash: 'hh',
    });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0xe37_800');

    // body(10) { senderUid(10) receiverUid(20) fileUuid(30) fileHash(40) }
    const innerBody = [...s(10, 'su'), ...s(20, 'ru'), ...s(30, 'uuid'), ...s(40, 'hh')];
    // req: subCommand(1)=800, field2(2)=0 omitted, body(10), field101(101)=3,
    //      field102(102)=1, field200(200)=1
    const req = [...v(1, 800), ...m(10, innerBody), ...v(101, 3), ...v(102, 1), ...v(200, 1)];
    const expected = env(0xE37, 800, req, false);
    expect(Buffer.from(bytes).toString('hex')).toBe(expected);
  });

  it('extracts the download-routing metadata from field30 of the response', async () => {
    const deps = makeDeps({
      body: { metadata: { field3: 5, field100: new Uint8Array([9, 9]), field101: new Uint8Array([8]), field110: 7, timestamp1: 42 } },
    });
    const meta = await FinalizeOfflineFile.invoke(deps, {
      senderUid: 'su', receiverUid: 'ru', fileUuid: 'uuid', fileHash: 'hh',
    });
    expect(meta.field3).toBe(5);
    expect(meta.field110).toBe(7);
    expect(meta.timestamp1).toBe(42);
    expect(Array.from(meta.field100 ?? [])).toEqual([9, 9]);
    expect(Array.from(meta.field101 ?? [])).toEqual([8]);
  });

  it('returns {} when the response carries no metadata', async () => {
    const deps = makeDeps({});
    const meta = await FinalizeOfflineFile.invoke(deps, {
      senderUid: 'su', receiverUid: 'ru', fileUuid: 'uuid', fileHash: 'hh',
    });
    expect(meta).toEqual({});
  });
});

describe('FileExtra.field6 (c2c download routing — issue #157)', () => {
  it('encodes field6.field2 with the exact NapCat tag layout', () => {
    const extra: FileExtra = {
      field6: {
        field2: {
          field1: 7,
          fileUuid: 'uu',
          fileName: 'n.bin',
          field6: 3,
          field7: new Uint8Array([1, 2]),
          field8: new Uint8Array([3]),
          timestamp1: 99,
          fileHash: 'hh',
          selfUid: 'su',
          destUid: 'du',
        },
      },
    };
    const hex = Buffer.from(protobuf_encode<FileExtra>(extra)).toString('hex');

    // PrivateFileExtraField2 in ascending tag order:
    //   field1(1) fileUuid(4) fileName(5) field6(6) field7(7,bytes)
    //   field8(8,bytes) timestamp1(9) fileHash(14) selfUid(15) destUid(16)
    const f2 = [
      ...v(1, 7),
      ...s(4, 'uu'),
      ...s(5, 'n.bin'),
      ...v(6, 3),
      ...b(7, [1, 2]),
      ...b(8, [3]),
      ...v(9, 99),
      ...s(14, 'hh'),
      ...s(15, 'su'),
      ...s(16, 'du'),
    ];
    // PrivateFileExtra { field2(2) } → FileExtra { field6(6) }
    const expected = Buffer.from(m(6, m(2, f2))).toString('hex');
    expect(hex).toBe(expected);
  });

  it('round-trips field6 through encode/decode', () => {
    const extra: FileExtra = {
      file: { fileUuid: 'u', fileName: 'f', subcmd: 1 },
      field6: { field2: { field1: 1, fileUuid: 'u', fileName: 'f', timestamp1: 5, selfUid: 's', destUid: 'd' } },
    };
    const back = protobuf_decode<FileExtra>(protobuf_encode<FileExtra>(extra));
    expect(back.field6?.field2).toMatchObject({
      field1: 1, fileUuid: 'u', fileName: 'f', timestamp1: 5, selfUid: 's', destUid: 'd',
    });
    expect(back.file?.subcmd).toBe(1);
  });
});
