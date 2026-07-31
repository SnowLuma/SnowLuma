import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import { SetFriendCategory } from '../../../src/oidb-services/contacts/set-friend-category';
import { env, s, v } from '../_pb-oracle';

function packet(errorCode = 0, errorMessage = ''): SendPacketResult {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbEmpty>>({
      command: 0x1255,
      subCommand: 0,
      errorCode,
      errorMsg: errorMessage,
    })),
  };
}

describe('SetFriendCategory namespace', () => {
  it('uses the client command and UIN-form envelope confirmed by the native worker', () => {
    expect(SetFriendCategory.command).toBe(0x1255);
    expect(SetFriendCategory.subCommand).toBe(0);
    expect(SetFriendCategory.uinForm).toBe(true);
  });

  it('serializes the friend UID and category ID with the verified field layout', async () => {
    const sendRawPacket = vi.fn(async () => packet());

    await SetFriendCategory.invoke({ sendRawPacket }, {
      uid: 'u_friend',
      categoryId: 7,
    });

    expect(sendRawPacket).toHaveBeenCalledOnce();
    const [command, bytes] = sendRawPacket.mock.calls[0]!;
    expect(command).toBe('OidbSvcTrpcTcp.0x1255_0');
    expect(Buffer.from(bytes).toString('hex')).toBe(
      env(0x1255, 0, [...s(1, 'u_friend'), ...v(2, 7)], true),
    );
  });

  it('accepts the idempotent success code used by the QQ client', async () => {
    const sendRawPacket = vi.fn(async () => packet(2_001_002));

    await expect(SetFriendCategory.invoke({ sendRawPacket }, {
      uid: 'u_friend',
      categoryId: 7,
    })).resolves.toBeUndefined();
  });

  it('accepts the idempotent result when the packet layer reports it directly', async () => {
    const sendRawPacket = vi.fn(async (): Promise<SendPacketResult> => ({
      success: false,
      gotResponse: true,
      errorCode: 2_001_002,
      errorMessage: 'already applied',
      responseData: null,
    }));

    await expect(SetFriendCategory.invoke({ sendRawPacket }, {
      uid: 'u_friend',
      categoryId: 7,
    })).resolves.toBeUndefined();
  });

  it('surfaces explicit server rejections', async () => {
    const sendRawPacket = vi.fn(async () => packet(42, 'denied'));

    await expect(SetFriendCategory.invoke({ sendRawPacket }, {
      uid: 'u_friend',
      categoryId: 7,
    })).rejects.toThrow(/42.*denied/);
  });

  it('does not mistake a transport failure with code zero for success', async () => {
    const sendRawPacket = vi.fn(async (): Promise<SendPacketResult> => ({
      success: false,
      gotResponse: true,
      errorCode: 0,
      errorMessage: 'packet send failed',
      responseData: null,
    }));

    await expect(SetFriendCategory.invoke({ sendRawPacket }, {
      uid: 'u_friend',
      categoryId: 7,
    })).rejects.toThrow('packet send failed');
  });
});
