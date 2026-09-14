import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileViewReq, OidbGroupFileViewResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { ListGroupFilesPage } from '../../../src/oidb-services/group-file/list-group-files-page';

function wireVarint(value: bigint): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    const byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    out.push(remaining === 0n ? byte : byte | 0x80);
  } while (remaining !== 0n);
  return out;
}

function varintField(fieldNumber: number, value: bigint): number[] {
  return [...wireVarint(BigInt(fieldNumber << 3)), ...wireVarint(value)];
}

function bytesField(fieldNumber: number, value: Uint8Array): number[] {
  return [
    ...wireVarint(BigInt((fieldNumber << 3) | 2)),
    ...wireVarint(BigInt(value.length)),
    ...value,
  ];
}

function stringField(fieldNumber: number, value: string): number[] {
  return bytesField(fieldNumber, new TextEncoder().encode(value));
}

function messageField(fieldNumber: number, value: number[]): number[] {
  return bytesField(fieldNumber, Uint8Array.from(value));
}

function makeDeps(body?: OidbGroupFileViewResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileViewResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('ListGroupFilesPage namespace', () => {
  it('declares 0x6D8_1 with uinForm=true', () => {
    expect(ListGroupFilesPage.command).toBe(0x6D8);
    expect(ListGroupFilesPage.subCommand).toBe(1);
    expect(ListGroupFilesPage.uinForm).toBe(true);
  });

  it('packages the page parameters (sortBy=1, field17=2, field18=0)', async () => {
    const deps = makeDeps({ list: { isEnd: true, items: [] } as any });
    await ListGroupFilesPage.invoke(deps, {
      groupId: 12345, targetDirectory: '/a', startIndex: 20, pageSize: 50,
    });
    const env = protobuf_decode<OidbBase<OidbGroupFileViewReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.list).toMatchObject({
      groupUin: 12345, appId: 7,
      targetDirectory: '/a', fileCount: 50,
      sortBy: 1, startIndex: 20,
      field17: 2,
    });
  });

  it('returns items and isEnd after checking list.retCode', async () => {
    const deps = makeDeps({
      list: { isEnd: false, items: [{ type: 1 }] } as any,
    });
    const out = await ListGroupFilesPage.invoke(deps, {
      groupId: 1, targetDirectory: '/', startIndex: 0, pageSize: 10,
    });
    expect(out).toEqual({ items: [expect.objectContaining({ type: 1 })], isEnd: false });
  });

  it('throws when list.retCode is non-zero', async () => {
    const deps = makeDeps({
      list: { retCode: 2, retMsg: 'busy', isEnd: true, items: [] } as any,
    });
    await expect(ListGroupFilesPage.invoke(deps, {
      groupId: 1, targetDirectory: '/', startIndex: 0, pageSize: 10,
    })).rejects.toThrow(/group file list failed: code=2/);
  });

  it('decodes the folder last-upload metadata from the QQ wire fields', async () => {
    // Independent wire fixture confirmed against QQ's group-file list decoder:
    // folder fields 5/9/10 are modify time, modifier UIN, and modifier name.
    const folder = [
      ...stringField(1, 'd1'),
      ...stringField(3, 'dir'),
      ...varintField(4, 100n),
      ...varintField(5, 200n),
      ...varintField(6, 123n),
      ...stringField(7, 'creator'),
      ...varintField(8, 2n),
      ...varintField(9, 5_000_000_001n),
      ...stringField(10, 'uploader'),
    ];
    const item = [...varintField(1, 2n), ...messageField(2, folder)];
    const list = [...varintField(4, 1n), ...messageField(5, item)];
    const body = messageField(2, list);
    const responseData = Buffer.from(messageField(4, body));
    const deps = {
      sendRawPacket: vi.fn(async (): Promise<SendPacketResult> => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData,
      })),
    };

    const out = await ListGroupFilesPage.invoke(deps, {
      groupId: 1, targetDirectory: '/', startIndex: 0, pageSize: 10,
    });
    const decoded = out?.items?.[0]?.folderInfo as Record<string, unknown> | undefined;

    expect(decoded).toMatchObject({
      modifiedTime: 200,
      modifierUin: 5_000_000_001n,
      modifierName: 'uploader',
    });
  });

  it('returns null when the server elides the list slot', async () => {
    const deps = makeDeps({});
    const out = await ListGroupFilesPage.invoke(deps, {
      groupId: 1, targetDirectory: '/', startIndex: 0, pageSize: 10,
    });
    expect(out).toBeNull();
  });
});
