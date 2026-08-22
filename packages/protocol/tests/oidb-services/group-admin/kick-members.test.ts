import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x8a0Req } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { KickMembers } from '../../../src/oidb-services/group-admin/kick-members';
import { m, s, v } from '../_pb-oracle';

const TRACE_UID_A = 'u_abcdefghijklmnopqrstuv';
const TRACE_UID_B = 'u_bbbbbbbbbbbbbbbbbbbbbb';

function kickResultItem(result: number, uid: string): number[] {
  return [...v(1, result), ...s(2, uid)];
}

function kickResponseBytes(groupUin: number, items: number[][]): Buffer {
  const body = [...v(1, groupUin), ...items.flatMap(item => m(2, item))];
  return Buffer.from(m(4, body));
}

function makeDeps(
  resolveSequence: string[] = ['uid-a', 'uid-b'],
  responseData: Buffer = Buffer.alloc(0),
) {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  const resolveUserUid = vi.fn();
  for (const uid of resolveSequence) resolveUserUid.mockResolvedValueOnce(uid);
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid,
  };
}

describe('KickMembers namespace', () => {
  it('declares 0x8A0_1 (same as KickMember; disambiguated by proto body)', () => {
    expect(KickMembers.command).toBe(0x8A0);
    expect(KickMembers.subCommand).toBe(1);
  });

  it('resolves each uid in parallel and packages targetUids[]', async () => {
    const deps = makeDeps(['uid-a', 'uid-b']);
    await KickMembers.invoke(deps, { groupId: 12345, userIds: [11, 22], reject: false });
    expect(deps.resolveUserUid).toHaveBeenCalledTimes(2);
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x8a0_1');
    const env = protobuf_decode<OidbBase<Oidb0x8a0Req>>(bytes);
    expect(env.body?.targetUids).toEqual(['uid-a', 'uid-b']);
    expect(env.body?.groupId).toBe(12345n);
    expect(env.body?.rejectAddRequest ?? 0).toBe(0);
  });

  it('reject=true => rejectAddRequest=1', async () => {
    const deps = makeDeps(['u']);
    await KickMembers.invoke(deps, { groupId: 1, userIds: [2], reject: true });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<Oidb0x8a0Req>>(bytes);
    expect(env.body?.rejectAddRequest).toBe(1);
  });

  it('treats an empty body as success', async () => {
    await expect(KickMembers.invoke(makeDeps(['u']), {
      groupId: 1, userIds: [2], reject: false,
    })).resolves.toBeUndefined();
  });

  it('treats zero per-member results as success (#413)', async () => {
    const bytes = kickResponseBytes(12345, [
      kickResultItem(0, TRACE_UID_A),
      kickResultItem(0, TRACE_UID_B),
    ]);
    const decoded = KickMembers.decode(bytes);
    expect(decoded.body?.results).toEqual([
      { result: 0, uid: TRACE_UID_A },
      { result: 0, uid: TRACE_UID_B },
    ]);

    await expect(KickMembers.invoke(makeDeps(['uid-a', 'uid-b'], bytes), {
      groupId: 12345, userIds: [11, 22], reject: false,
    })).resolves.toBeUndefined();
  });

  it('rejects when any per-member result is non-zero, with the numeric code', async () => {
    const bytes = kickResponseBytes(12345, [
      kickResultItem(0, TRACE_UID_A),
      kickResultItem(7, TRACE_UID_B),
    ]);
    await expect(KickMembers.invoke(makeDeps(['uid-a', 'uid-b'], bytes), {
      groupId: 12345, userIds: [11, 22], reject: false,
    })).rejects.toThrow('kick members failed: result=7');
  });
});
