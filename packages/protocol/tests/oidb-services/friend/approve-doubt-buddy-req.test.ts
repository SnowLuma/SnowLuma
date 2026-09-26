import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { ApproveDoubtBuddyReq } from '../../../src/oidb-services/friend/approve-doubt-buddy-req';
import { env, s, v } from '../_pb-oracle';

function makeSender(selfUid = 'u_self', selfUin = '10001') {
  const respEnv: OidbBase<OidbEmpty> = { command: 0xD72, subCommand: 0, body: {} };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbEmpty>>(respEnv)),
  };
  return {
    sendRawPacket: vi.fn(async (_cmd: string, _bytes: Uint8Array) => r),
    identity: { selfUid, uin: selfUin } as ApproveDoubtBuddyReq.Deps['identity'],
    resolveUserUid: vi.fn(async () => 'u_lookup_self'),
  };
}

describe('ApproveDoubtBuddyReq namespace', () => {
  it('keeps the approving account separate from the applicant', async () => {
    const sender = makeSender();
    expect(await ApproveDoubtBuddyReq.serialize(sender, { uid: 'u_applicant' })).toEqual({
      selfUid: 'u_self', targetUid: 'u_applicant', field3: 0, field4: '',
    });
    expect(sender.resolveUserUid).not.toHaveBeenCalled();
  });

  it('matches the approval request bytes including explicit default options', async () => {
    const sender = makeSender();
    await ApproveDoubtBuddyReq.invoke(sender, { uid: 'u_applicant' });

    expect(sender.sendRawPacket).toHaveBeenCalledOnce();
    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xd72_0');
    const body = [...s(1, 'u_self'), ...s(2, 'u_applicant'), ...v(3, 0), ...s(4, '')];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0xD72, 0, body, false));
  });

  it('resolves the current account when its self profile is not cached', async () => {
    const sender = makeSender('');
    await ApproveDoubtBuddyReq.invoke(sender, { uid: 'u_applicant' });
    expect(sender.resolveUserUid).toHaveBeenCalledWith(10001);
    const body = [...s(1, 'u_lookup_self'), ...s(2, 'u_applicant'), ...v(3, 0), ...s(4, '')];
    expect(Buffer.from(sender.sendRawPacket.mock.calls[0]![1]).toString('hex'))
      .toBe(env(0xD72, 0, body, false));
  });

  it('does not send when the current account cannot be identified', async () => {
    const sender = makeSender('', '0');
    await expect(ApproveDoubtBuddyReq.invoke(sender, { uid: 'u_applicant' }))
      .rejects.toThrow('self uid is unavailable');
    expect(sender.sendRawPacket).not.toHaveBeenCalled();
    expect(sender.resolveUserUid).not.toHaveBeenCalled();
  });

  it('propagates self identity lookup errors without sending', async () => {
    const sender = makeSender('');
    sender.resolveUserUid.mockRejectedValue(new Error('profile lookup failed'));
    await expect(ApproveDoubtBuddyReq.invoke(sender, { uid: 'u_applicant' }))
      .rejects.toThrow('profile lookup failed');
    expect(sender.sendRawPacket).not.toHaveBeenCalled();
  });

  it('rejects an empty resolved self identity before sending', async () => {
    const sender = makeSender('');
    sender.resolveUserUid.mockResolvedValue('');
    await expect(ApproveDoubtBuddyReq.invoke(sender, { uid: 'u_applicant' }))
      .rejects.toThrow('self uid is unavailable');
    expect(sender.sendRawPacket).not.toHaveBeenCalled();
  });

  it.each(['', ' '])('rejects an absent applicant identity (%j)', async (uid) => {
    const sender = makeSender();
    await expect(ApproveDoubtBuddyReq.invoke(sender, { uid }))
      .rejects.toThrow('applicant uid is unavailable');
    expect(sender.sendRawPacket).not.toHaveBeenCalled();
  });

  it('propagates a rejected approval without retrying a different operation', async () => {
    const sender = makeSender();
    sender.sendRawPacket.mockResolvedValue({
      success: false, gotResponse: true, errorCode: 1201,
      errorMessage: 'request rejected', responseData: Buffer.alloc(0),
    });
    await expect(ApproveDoubtBuddyReq.invoke(sender, { uid: 'u_applicant' }))
      .rejects.toThrow('request rejected');
    expect(sender.sendRawPacket).toHaveBeenCalledOnce();
  });

  it('does not mistake a successful transport for an accepted approval', async () => {
    const sender = makeSender();
    sender.sendRawPacket.mockResolvedValue({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<OidbEmpty>>({
        command: 0xD72, subCommand: 0, errorCode: 1201, errorMsg: 'approval denied', body: {},
      })),
    });
    await expect(ApproveDoubtBuddyReq.invoke(sender, { uid: 'u_applicant' }))
      .rejects.toThrow('approval denied');
    expect(sender.sendRawPacket).toHaveBeenCalledOnce();
  });
});
