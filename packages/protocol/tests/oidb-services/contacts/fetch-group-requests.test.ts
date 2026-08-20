import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { pb, pb_repeated, uint_32, uint_64 } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0x10C0Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestList } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import {
  FetchGroupRequests,
  FetchGroupRequestsByUid,
  groupRequestOperationType,
} from '../../../src/oidb-services/contacts/fetch-group-requests';

interface ObservedGroupRequestUserByUin {
  uin?: pb<1, uint_32>;
  name?: pb<2, string>;
}

interface ObservedGroupRequestGroup {
  groupUin?: pb<1, uint_32>;
  groupName?: pb<2, string>;
}

interface ObservedGroupRequestByUin {
  sequence?: pb<1, uint_64>;
  eventType?: pb<2, uint_32>;
  state?: pb<3, uint_32>;
  group?: pb<4, ObservedGroupRequestGroup>;
  target?: pb<5, ObservedGroupRequestUserByUin>;
  invitor?: pb<6, ObservedGroupRequestUserByUin>;
  operatorUser?: pb<7, ObservedGroupRequestUserByUin>;
  comment?: pb<10, string>;
}

interface ObservedGroupRequestResponseByUin {
  requests?: pb_repeated<1, ObservedGroupRequestByUin>;
  cursor?: pb<2, uint_64>;
}

function makeSender() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchGroupRequests namespace', () => {
  it('maps native list notification types to 0x10C8 operation types', () => {
    expect(groupRequestOperationType(1)).toBe(2);
    expect(groupRequestOperationType(7)).toBe(1);
    expect(groupRequestOperationType(17)).toBe(100);
    expect(groupRequestOperationType(5)).toBe(22);
    expect(groupRequestOperationType(22)).toBe(22);
    expect(groupRequestOperationType(99)).toBeNull();
  });

  it('declares 0x10C0', () => {
    expect(FetchGroupRequests.command).toBe(0x10C0);
    expect(FetchGroupRequests.uinForm).toBe(true);
    expect((FetchGroupRequestsByUid as { uinForm?: boolean }).uinForm).toBeUndefined();
  });

  describe('resolveSubCommand', () => {
    it('returns 1 when filtered=false (main inbox)', () => {
      expect(FetchGroupRequests.resolveSubCommand({ filtered: false })).toBe(1);
    });
    it('returns 2 when filtered=true (low-priority inbox)', () => {
      expect(FetchGroupRequests.resolveSubCommand({ filtered: true })).toBe(2);
    });
  });

  describe('serialize', () => {
    it('defaults to one native 50-item screen at cursor zero', () => {
      expect(FetchGroupRequests.serialize({} as any, { filtered: false })).toEqual({ count: 50, field2: 0n });
      expect(FetchGroupRequestsByUid.serialize({} as any, { filtered: true })).toEqual({ count: 50, field2: 0n });
    });

    it('preserves a caller-provided count and 64-bit cursor', () => {
      const cursor = 1_785_406_628_779_279n;
      expect(FetchGroupRequests.serialize({} as any, {
        filtered: false,
        count: 80,
        cursor,
      })).toEqual({ count: 80, field2: cursor });
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to 0x10c0_1 for the main inbox', async () => {
      const sender = makeSender();
      await FetchGroupRequests.invoke(sender, { filtered: false });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x10c0_1');
    });

    it('routes to 0x10c0_2 for the filtered inbox', async () => {
      const sender = makeSender();
      await FetchGroupRequests.invoke(sender, { filtered: true });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x10c0_2');
    });

    it('encodes the native envelope and requested screen', async () => {
      const sender = makeSender();
      await FetchGroupRequests.invoke(sender, {
        filtered: false,
        count: 80,
        cursor: 1_785_406_628_779_279n,
      });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGroupRequestList>>(bytes);
      expect(env.reserved).toBe(1);
      expect(env.body).toEqual({ count: 80, field2: 1_785_406_628_779_279n });
    });

    it('decodes numeric account identifiers from the native response', async () => {
      const responseData = Buffer.from(protobuf_encode<OidbBase<ObservedGroupRequestResponseByUin>>({
        body: {
          requests: [{
            sequence: 1_785_525_232_784_291n,
            eventType: 7,
            state: 1,
            group: { groupUin: 1_095_186_374, groupName: 'group' },
            target: { uin: 1_234_567_890, name: 'requester' },
            invitor: { uin: 2_345_678_901, name: 'inviter' },
            operatorUser: { uin: 3_456_789_012, name: 'operator' },
            comment: 'please',
          }],
          cursor: 1_785_406_628_779_279n,
        },
      }));
      const result: SendPacketResult = {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData,
      };
      const sender = { sendRawPacket: vi.fn(async () => result) };

      const response = await FetchGroupRequests.invoke(sender, { filtered: false });

      expect(response.requests?.[0]).toMatchObject({
        target: { uin: 1_234_567_890, uid: '', name: 'requester' },
        invitor: { uin: 2_345_678_901, uid: '', name: 'inviter' },
        operatorUser: { uin: 3_456_789_012, uid: '', name: 'operator' },
      });
      expect(response.field2).toBe(1_785_406_628_779_279n);
    });

    it('keeps string account identifiers from the native reply', async () => {
      const responseData = Buffer.from(protobuf_encode<OidbBase<OidbSvcTrpcTcp0x10C0Response>>({
        body: {
          requests: [{
            sequence: 99n,
            eventType: 5,
            state: 1,
            group: { groupUin: 1001, groupName: 'group' },
            target: { uid: 'u_target', name: 'invitee' },
            invitor: { uid: 'u_inviter', name: 'inviter' },
            comment: 'join us',
          }],
        },
      }));
      const sender = {
        sendRawPacket: vi.fn(async () => ({
          success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData,
        })),
      };

      const response = await FetchGroupRequests.invoke(sender, { filtered: false });

      expect(response.requests?.[0]).toMatchObject({
        eventType: 5,
        target: { uid: 'u_target', uin: 0, name: 'invitee' },
        invitor: { uid: 'u_inviter', uin: 0, name: 'inviter' },
        comment: 'join us',
      });
    });

    it('keeps the UID response path on the non-native envelope', async () => {
      const sender = makeSender();
      await FetchGroupRequestsByUid.invoke(sender, { filtered: false });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGroupRequestList>>(bytes);
      expect(env.reserved ?? 0).toBe(0);
    });
  });
});
