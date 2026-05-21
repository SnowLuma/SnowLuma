import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x9083Resp } from '@snowluma/proto-defs/oidb-actions/base';

// `encodeOidbEnv` / `decodeOidbEnv` are proton-bound pass-through wrappers
// that the plugin substitutes at the call site for the inlined codec.
// That means production calls to them NEVER hit the imported function —
// mocking them on the module object is a no-op. The only mockable point
// is `runOidb` (non-generic, untouched by proton) returning real bytes
// that the production-side codec actually decodes. `makeOidbEnvelope` is
// a pure TS helper, so its mock works for introspection.
vi.mock('@snowluma/bridge/bridge-oidb', async () => {
  const actual = await vi.importActual<typeof import('@snowluma/bridge/bridge-oidb')>(
    '@snowluma/bridge/bridge-oidb',
  );
  return {
    ...actual,
    runOidb: vi.fn(async () => new Uint8Array()),
    makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  };
});

import * as oidb from '@snowluma/bridge/bridge-oidb';
import { InteractionApi } from '../../src/bridge/apis/interaction';
import { mockBridge } from './_helpers';

describe('apis/interaction', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue(new Uint8Array());
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
  });

  it('sendPoke group: groupUin set, friendUin=0', async () => {
    const bridge = mockBridge();
    await new InteractionApi(bridge as any).sendPoke(true, 12345, 67890);
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(body).toMatchObject({ uin: 67890, groupUin: 12345, friendUin: 0 });
  });

  it('sendPoke friend: friendUin set, groupUin=0, targetUin defaults to peer', async () => {
    const bridge = mockBridge();
    await new InteractionApi(bridge as any).sendPoke(false, 67890);
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(body).toMatchObject({ uin: 67890, groupUin: 0, friendUin: 67890 });
  });

  it('sendLike forwards target + count to 0x7e5_104', async () => {
    const bridge = mockBridge();
    await new InteractionApi(bridge as any).sendLike(10001, 3);
    const [, cmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x7e5_104');
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(body).toMatchObject({ targetUin: 10001, count: 3 });
  });

  it('setReaction picks _1 for set and _2 for unset', async () => {
    const bridge = mockBridge();
    const api = new InteractionApi(bridge as any);
    await api.setReaction(12345, 99, '128516', true);
    await api.setReaction(12345, 99, '128516', false);
    const cmds = vi.mocked(oidb.runOidb).mock.calls.map(c => c[1]);
    expect(cmds).toEqual(['OidbSvcTrpcTcp.0x9082_1', 'OidbSvcTrpcTcp.0x9082_2']);
  });

  it('setEssence picks _1 for enable and _2 for disable', async () => {
    const bridge = mockBridge();
    const api = new InteractionApi(bridge as any);
    await api.setEssence(12345, 99, 0, true);
    await api.setEssence(12345, 99, 0, false);
    const cmds = vi.mocked(oidb.runOidb).mock.calls.map(c => c[1]);
    expect(cmds).toEqual(['OidbSvcTrpcTcp.0xeac_1', 'OidbSvcTrpcTcp.0xeac_2']);
  });

  it('getEmojiLikes decodes user list, base64-encodes cookie, and reports isLast', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<Oidb0x9083Resp>>({
        body: {
          inner: { userInfo: { uin: 10001n } },
          cookie: new Uint8Array([0xCA, 0xFE]),
        } as any,
      }),
    );
    const out = await new InteractionApi(bridge as any).getEmojiLikes(12345, 99, '128516');
    expect(out.users).toEqual([{ uin: 10001 }]);
    expect(out.cookie).toBe(Buffer.from([0xCA, 0xFE]).toString('base64'));
    expect(out.isLast).toBe(false);
  });

  it('getEmojiLikes reports isLast=true when no cookie comes back', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<Oidb0x9083Resp>>({ body: {} }),
    );
    const out = await new InteractionApi(bridge as any).getEmojiLikes(12345, 99, '128516');
    expect(out.users).toEqual([]);
    expect(out.isLast).toBe(true);
  });
});
