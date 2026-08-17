import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0HistoryVisibility } from '@snowluma/proto-defs/oidb-actions/base';

import {
  decodeGroupHistoryVisibility,
  GROUP_HISTORY_VISIBILITY_MASK,
  mergeGroupHistoryVisibility,
  SetNewMemberHistoryVisibility,
} from '../../../src/oidb-services/group-admin/set-new-member-history-visibility';

function makeSender() {
  const result: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => result) };
}

describe('SetNewMemberHistoryVisibility namespace', () => {
  it.each([
    [true, 0x80000001, 0x80000005],
    [false, 0x80000005, 0x80000001],
  ])('writes visible=%s without changing unrelated bits', async (visible, current, expected) => {
    const sender = makeSender();

    await SetNewMemberHistoryVisibility.invoke(sender, {
      groupId: 12345,
      currentGroupFlagExt4: current,
      visible,
    });

    const [command, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(command).toBe('OidbSvcTrpcTcp.0x89a_0');
    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0HistoryVisibility>>(bytes);
    expect(envelope.command).toBe(0x89A);
    expect(envelope.body).toMatchObject({
      groupUin: 12345n,
      settings: {
        groupFlagExt4: expected,
        groupFlagExt4Mask: GROUP_HISTORY_VISIBILITY_MASK,
      },
    });
  });

  it('merges only the verified history-visibility bit', () => {
    expect(mergeGroupHistoryVisibility(0xF0000001, true)).toBe(0xF0000005);
    expect(mergeGroupHistoryVisibility(0xF0000005, false)).toBe(0xF0000001);
  });

  it('decodes the history-visibility bit', () => {
    expect(decodeGroupHistoryVisibility(0x80000001)).toBe(false);
    expect(decodeGroupHistoryVisibility(0x80000005)).toBe(true);
    expect(decodeGroupHistoryVisibility(0)).toBe(false);
  });

  it('round-trips history visibility through merge then decode', () => {
    expect(decodeGroupHistoryVisibility(mergeGroupHistoryVisibility(0x80000001, true))).toBe(true);
    expect(decodeGroupHistoryVisibility(mergeGroupHistoryVisibility(0x80000005, false))).toBe(false);
  });

  it('keeps an explicit zero value on the wire', async () => {
    const sender = makeSender();
    await SetNewMemberHistoryVisibility.invoke(sender, {
      groupId: 1,
      currentGroupFlagExt4: GROUP_HISTORY_VISIBILITY_MASK,
      visible: false,
    });

    const envelope = protobuf_decode<OidbBase<Oidb0x89a_0HistoryVisibility>>(
      sender.sendRawPacket.mock.calls[0]![1],
    );
    expect(envelope.body?.settings?.groupFlagExt4).toBe(0);
    expect(envelope.body?.settings?.groupFlagExt4Mask).toBe(GROUP_HISTORY_VISIBILITY_MASK);
  });

  it('rejects an invalid current flag before sending', async () => {
    const sender = makeSender();
    await expect(SetNewMemberHistoryVisibility.invoke(sender, {
      groupId: 1,
      currentGroupFlagExt4: -1,
      visible: true,
    })).rejects.toThrow(/unsigned 32-bit/);
    expect(sender.sendRawPacket).not.toHaveBeenCalled();
  });
});
