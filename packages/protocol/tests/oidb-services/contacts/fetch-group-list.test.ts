import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchGroupList } from '../../../src/oidb-services/contacts/fetch-group-list';

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

    it('sends the verbatim config blob (field5002/5003 OFF to avoid EPIPE on big rosters)', async () => {
      const sender = makeSender();
      await FetchGroupList.invoke(sender);
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGroupListRequest>>(bytes);
      expect(env.body?.config?.config1?.groupName).toBe(true);
      expect(env.body?.config?.config1?.memberCount).toBe(true);
      // proto3 default false — omitted on wire, decoded as null.
      expect(env.body?.config?.config1?.field5002 ?? false).toBe(false);
      expect(env.body?.config?.config1?.field5003 ?? false).toBe(false);
    });
  });
});
