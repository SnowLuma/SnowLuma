import { describe, expect, it, vi } from 'vitest';
import {
  protobuf_decode,
  protobuf_encode,
  type pb,
  type pb_repeated,
  type uint_32,
} from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchGroupList } from '../../../src/oidb-services/contacts/fetch-group-list';

interface GroupInfoFixture {
  groupName?: pb<5, string>;
  shutUpAllTimestamp?: pb<10, uint_32>;
  leftover31?: pb<31, uint_32>;
}

interface GroupFixture {
  groupUin?: pb<3, uint_32>;
  info?: pb<4, GroupInfoFixture>;
}

interface GroupListFixture {
  groups?: pb_repeated<2, GroupFixture>;
}

function makeSender() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchGroupList namespace', () => {
  it('declares 0xFE5_2 with uinForm=true', () => {
    expect(FetchGroupList.command).toBe(0xFE5);
    expect(FetchGroupList.subCommand).toBe(2);
    expect(FetchGroupList.uinForm).toBe(true);
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0xfe5_2 with envelope reserved=1', async () => {
      const sender = makeSender();
      await FetchGroupList.invoke(sender);
      const [wireName, bytes] = sender.sendRawPacket.mock.calls[0]!;
      expect(wireName).toBe('OidbSvcTrpcTcp.0xfe5_2');
      const env = protobuf_decode<OidbBase<OidbGroupListRequest>>(bytes);
      expect(env.reserved).toBe(1);
    });

    it('requests group remarks without enabling the other costly optional fields', async () => {
      const sender = makeSender();
      await FetchGroupList.invoke(sender);
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGroupListRequest>>(bytes);
      expect(env.body?.config?.config1?.groupName).toBe(true);
      expect(env.body?.config?.config1?.memberCount).toBe(true);
      expect(env.body?.config?.config1?.field10).toBe(true);
      expect(env.body?.config?.config2?.remark).toBe(true);
      for (const field of ['field1', 'field2', 'field4', 'field5', 'field6', 'field7', 'field8'] as const) {
        expect(env.body?.config?.config2?.[field] ?? false, field).toBe(false);
      }
      // proto3 default false — omitted on wire, decoded as null.
      expect(env.body?.config?.config1?.field5002 ?? false).toBe(false);
      expect(env.body?.config?.config1?.field5003 ?? false).toBe(false);
    });

    it('decodes the group-wide mute timestamp returned with the joined roster', async () => {
      const responseData = Buffer.from(protobuf_encode<OidbBase<GroupListFixture>>({
        body: {
          groups: [{
            groupUin: 123456789,
            info: { groupName: 'Muted Group', shutUpAllTimestamp: 4_294_967_295 },
          }],
        },
      }));
      const sender = makeSender();
      sender.sendRawPacket.mockResolvedValue({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData,
      });

      const out = await FetchGroupList.invoke(sender);

      expect(out.groups?.[0]?.info?.shutUpAllTimestamp).toBe(4_294_967_295);
    });

    it('does not treat 0xFE5 info tag 31 as the mute expire (#356)', async () => {
      const responseData = Buffer.from(protobuf_encode<OidbBase<GroupListFixture>>({
        body: {
          groups: [{
            groupUin: 123456789,
            info: { groupName: 'Unmuted Group', leftover31: 4_294_967_295 },
          }],
        },
      }));
      const sender = makeSender();
      sender.sendRawPacket.mockResolvedValue({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData,
      });

      const out = await FetchGroupList.invoke(sender);

      expect(out.groups?.[0]?.info?.shutUpAllTimestamp ?? undefined).toBeUndefined();
    });
  });
});
