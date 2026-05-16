import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/bridge-oidb', () => ({
  runOidb: vi.fn(async () => ({})),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as inter from '../../src/bridge/actions/interaction';
import { mockBridge } from './_helpers';

describe('actions/interaction', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue({});
  });

  it('sendPoke group: groupUin set, friendUin=0', async () => {
    const bridge = mockBridge();
    await inter.sendPoke(bridge as any, true, 12345, 67890);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.request.value).toMatchObject({ uin: 67890, groupUin: 12345, friendUin: 0 });
  });

  it('sendPoke friend: friendUin set, groupUin=0, targetUin defaults to peer', async () => {
    const bridge = mockBridge();
    await inter.sendPoke(bridge as any, false, 67890);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.request.value).toMatchObject({ uin: 67890, groupUin: 0, friendUin: 67890 });
  });

  it('sendLike forwards target + count to 0x7e5_104', async () => {
    const bridge = mockBridge();
    await inter.sendLike(bridge as any, 10001, 3);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0x7e5_104');
    expect(call.request.value).toMatchObject({ targetUin: 10001, count: 3 });
  });

  it('setGroupReaction picks _1 for set and _2 for unset', async () => {
    const bridge = mockBridge();
    await inter.setGroupReaction(bridge as any, 12345, 99, '128516', true);
    await inter.setGroupReaction(bridge as any, 12345, 99, '128516', false);
    const cmds = vi.mocked(oidb.runOidb).mock.calls.map(c => c[1].cmd);
    expect(cmds).toEqual(['OidbSvcTrpcTcp.0x9082_1', 'OidbSvcTrpcTcp.0x9082_2']);
  });

  it('getEmojiLikes decodes user list, base64-encodes cookie, and reports isLast', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      inner: { userInfo: { uin: 10001 } },
      cookie: new Uint8Array([0xCA, 0xFE]),
    });
    const out = await inter.getEmojiLikes(bridge as any, 12345, 99, '128516');
    expect(out.users).toEqual([{ uin: 10001 }]);
    expect(out.cookie).toBe(Buffer.from([0xCA, 0xFE]).toString('base64'));
    expect(out.isLast).toBe(false);
  });

  it('getEmojiLikes reports isLast=true when no cookie comes back', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({});
    const out = await inter.getEmojiLikes(bridge as any, 12345, 99, '128516');
    expect(out.users).toEqual([]);
    expect(out.isLast).toBe(true);
  });
});
