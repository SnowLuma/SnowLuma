import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbKickMember } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { KickMember } from '../../../src/oidb-services/group-admin/kick-member';
import { m, s, v } from '../_pb-oracle';

/** 24-byte uid: success items on the wire are `{ result:0, uid }` with uid length 0x18. */
const TRACE_UID = 'u_abcdefghijklmnopqrstuv';

function kickResultItem(result: number, uid: string): number[] {
  return [...v(1, result), ...s(2, uid)];
}

function kickResponseBytes(groupUin: number, items: number[][]): Buffer {
  const body = [...v(1, groupUin), ...items.flatMap(item => m(2, item))];
  return Buffer.from(m(4, body));
}

function makeDeps(responseData: Buffer = Buffer.alloc(0)) {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('KickMember namespace', () => {
  it('declares 0x8A0_1', () => {
    expect(KickMember.command).toBe(0x8A0);
    expect(KickMember.subCommand).toBe(1);
  });

  it('resolves uid per-group and forwards reject + reason', async () => {
    const deps = makeDeps();
    await KickMember.invoke(deps, { groupId: 12345, userId: 67890, reject: true, reason: 'bye' });
    expect(deps.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x8a0_1');
    const env = protobuf_decode<OidbBase<OidbKickMember>>(bytes);
    expect(env.body).toMatchObject({
      groupUin: 12345, targetUid: 'resolved-uid', rejectAddRequest: true, reason: 'bye',
    });
  });

  it('defaults reason to empty string', async () => {
    const deps = makeDeps();
    await KickMember.invoke(deps, { groupId: 1, userId: 2, reject: false });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbKickMember>>(bytes);
    expect(env.body?.reason ?? '').toBe('');
    expect(env.body?.rejectAddRequest ?? false).toBe(false);
  });

  it('treats an empty body as success', async () => {
    await expect(KickMember.invoke(makeDeps(), {
      groupId: 1, userId: 2, reject: false,
    })).resolves.toBeUndefined();
  });

  it('treats a zero per-member result plus uid as success (#413)', async () => {
    const bytes = kickResponseBytes(12345, [kickResultItem(0, TRACE_UID)]);
    const decoded = KickMember.decode(bytes);
    expect(decoded.body?.groupUin).toBe(12345);
    expect(decoded.body?.results).toEqual([{ result: 0, uid: TRACE_UID }]);

    await expect(KickMember.invoke(makeDeps(bytes), {
      groupId: 12345, userId: 67890, reject: false,
    })).resolves.toBeUndefined();
  });

  it('rejects a non-zero per-member result with the numeric code, not the uid (#298)', async () => {
    const bytes = kickResponseBytes(12345, [kickResultItem(7, TRACE_UID)]);
    await expect(KickMember.invoke(makeDeps(bytes), {
      groupId: 12345, userId: 67890, reject: false,
    })).rejects.toThrow('kick member failed: result=7');
  });

  it('deserialize: omitted/zero results succeed; non-zero throws', () => {
    expect(() => KickMember.deserialize({} as never, {})).not.toThrow();
    expect(() => KickMember.deserialize({} as never, { results: [] })).not.toThrow();
    expect(() => KickMember.deserialize({} as never, {
      results: [{ result: 0, uid: TRACE_UID }],
    })).not.toThrow();
    expect(() => KickMember.deserialize({} as never, {
      results: [{ uid: TRACE_UID }],
    })).not.toThrow();
    expect(() => KickMember.deserialize({} as never, {
      results: [{ result: 1, uid: TRACE_UID }],
    })).toThrow('kick member failed: result=1');
  });
});
