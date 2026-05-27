import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x9083Resp } from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';

// Post-namespace-migration: InteractionApi is a thin facade and
// production code routes through the namespace path (sender →
// sendRawPacket). Tests now assert against the bridge mock's
// sendRawPacket directly — no need for module-level mocks on the
// bridge-oidb internals.
import { InteractionApi } from '../../src/apis/interaction';
import { mockBridge } from './_helpers';

describe('apis/interaction', () => {

  it('sendPoke group: groupUin set, friendUin=0', async () => {
    const bridge = mockBridge();
    await new InteractionApi(bridge as any).sendPoke(true, 12345, 67890);
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xed3_1');
  });

  it('sendPoke friend: friendUin set, groupUin=0, targetUin defaults to peer', async () => {
    const bridge = mockBridge();
    await new InteractionApi(bridge as any).sendPoke(false, 67890);
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xed3_1');
  });

  it('sendLike forwards target + count to 0x7e5_104', async () => {
    const bridge = mockBridge();
    await new InteractionApi(bridge as any).sendLike(10001, 3);
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x7e5_104');
  });

  it('setReaction picks _1 for set and _2 for unset', async () => {
    // setReaction now forwards through the SetReaction namespace, which
    // calls bridge.sendRawPacket directly (bypassing runOidb).
    const bridge = mockBridge();
    const api = new InteractionApi(bridge as any);
    await api.setReaction(12345, 99, '128516', true);
    await api.setReaction(12345, 99, '128516', false);
    const cmds = bridge.sendRawPacket.mock.calls.map((c: any[]) => c[0]);
    expect(cmds).toEqual(['OidbSvcTrpcTcp.0x9082_1', 'OidbSvcTrpcTcp.0x9082_2']);
  });

  it('setEssence picks _1 for enable and _2 for disable', async () => {
    const bridge = mockBridge();
    const api = new InteractionApi(bridge as any);
    await api.setEssence(12345, 99, 0, true);
    await api.setEssence(12345, 99, 0, false);
    const cmds = bridge.sendRawPacket.mock.calls.map((c: any[]) => c[0]);
    expect(cmds).toEqual(['OidbSvcTrpcTcp.0xeac_1', 'OidbSvcTrpcTcp.0xeac_2']);
  });

  it('getEmojiLikes decodes user list, base64-encodes cookie, and reports isLast', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0x9083Resp>>({
        body: {
          inner: { userInfo: [{ uin: 10001n }, { uin: 20002n }] },
          cookie: new Uint8Array([0xCA, 0xFE]),
        } as any,
      })),
    });
    const out = await new InteractionApi(bridge as any).getEmojiLikes(12345, 99, '128516');
    expect(out.users).toEqual([{ uin: 10001 }, { uin: 20002 }]);
    expect(out.cookie).toBe(Buffer.from([0xCA, 0xFE]).toString('base64'));
    expect(out.isLast).toBe(false);
  });

  it('getEmojiLikes reports isLast=true when no cookie comes back', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0x9083Resp>>({ body: {} })),
    });
    const out = await new InteractionApi(bridge as any).getEmojiLikes(12345, 99, '128516');
    expect(out.users).toEqual([]);
    expect(out.isLast).toBe(true);
  });
});
