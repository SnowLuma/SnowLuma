import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileViewReq, OidbGroupFileViewResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { ListGroupFilesPage } from '../../../src/oidb-services/group-file/list-group-files-page';

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

  it('returns the list body so the facade can walk items / isEnd', async () => {
    const deps = makeDeps({
      list: { isEnd: false, items: [{ type: 1 }] } as any,
    });
    const out = await ListGroupFilesPage.invoke(deps, {
      groupId: 1, targetDirectory: '/', startIndex: 0, pageSize: 10,
    });
    expect(out?.isEnd ?? false).toBe(false);
    expect(out?.items).toHaveLength(1);
  });

  it('returns null when the server elides the list slot', async () => {
    const deps = makeDeps({});
    const out = await ListGroupFilesPage.invoke(deps, {
      groupId: 1, targetDirectory: '/', startIndex: 0, pageSize: 10,
    });
    expect(out).toBeNull();
  });
});
