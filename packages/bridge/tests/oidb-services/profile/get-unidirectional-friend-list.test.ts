import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xe17Req, Oidb0xe17Resp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetUnidirectionalFriendList } from '../../../src/oidb-services/profile/get-unidirectional-friend-list';

function makeDeps(responseJson?: unknown) {
  const responseData = responseJson !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<Oidb0xe17Resp>>({
      body: { jsonBody: JSON.stringify(responseJson) },
    }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return {
    sendRawPacket: vi.fn(async () => r),
    identity: { uin: '10001' } as any,
  };
}

describe('GetUnidirectionalFriendList namespace', () => {
  it('declares 0xE17_0', () => {
    expect(GetUnidirectionalFriendList.command).toBe(0xE17);
    expect(GetUnidirectionalFriendList.subCommand).toBe(0);
  });

  it('overrides the wire name to MQUpdateSvc.OidbSvc.0xe17_0', async () => {
    const deps = makeDeps({ rpt_block_list: [] });
    await GetUnidirectionalFriendList.invoke(deps);
    expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0');
  });

  describe('serialize', () => {
    it('JSON-encodes the request body with the bot uin and fixed pagination', async () => {
      const deps = makeDeps({ rpt_block_list: [] });
      await GetUnidirectionalFriendList.invoke(deps);
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0xe17Req>>(bytes);
      const parsed = JSON.parse(env.body?.jsonBody ?? '{}');
      expect(parsed).toEqual({
        uint64_uin: '10001',
        uint64_top: 0,
        uint32_req_num: 99,
        bytes_cookies: '',
      });
    });
  });

  describe('deserialize', () => {
    it('parses the embedded JSON body and returns rpt_block_list', () => {
      const out = GetUnidirectionalFriendList.deserialize({
        jsonBody: JSON.stringify({ rpt_block_list: [{ uin: 10001 }, { uin: 10002 }] }),
      });
      expect(out).toEqual([{ uin: 10001 }, { uin: 10002 }]);
    });

    it('returns [] when rpt_block_list is absent', () => {
      const out = GetUnidirectionalFriendList.deserialize({ jsonBody: JSON.stringify({}) });
      expect(out).toEqual([]);
    });

    it('throws when jsonBody is empty / missing', () => {
      expect(() => GetUnidirectionalFriendList.deserialize({})).toThrow('get unidirectional friend list empty');
      expect(() => GetUnidirectionalFriendList.deserialize({ jsonBody: '' })).toThrow('get unidirectional friend list empty');
    });
  });

  describe('invoke (e2e)', () => {
    it('returns the parsed block list', async () => {
      const deps = makeDeps({ rpt_block_list: [{ uin: 999 }] });
      const out = await GetUnidirectionalFriendList.invoke(deps);
      expect(out).toEqual([{ uin: 999 }]);
    });
  });
});
