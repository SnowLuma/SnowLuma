import { describe, expect, it, vi } from 'vitest';

vi.mock('@snowluma/protocol/bridge-oidb', () => ({
  runOidb: vi.fn(async () => new Uint8Array()),
  makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  encodeOidbEnv: vi.fn(() => new Uint8Array()),
  decodeOidbEnv: vi.fn(() => ({ body: {} })),
}));

// element-builder reaches into protoEncode with element-specific schemas
// that we don't want to construct manually in tests; stub it to return
// a benign placeholder.
vi.mock('@snowluma/protocol/element-builder', () => ({
  buildSendElems: vi.fn(async () => []),
}));

import type { SendLongMsgResp } from '@snowluma/proto-defs/longmsg';
import { protobuf_encode } from '@snowluma/proton';
import { ForwardApi } from '../../src/apis/forward';
import { mockBridge } from './_helpers';

function uploadResponseWithResId(resId: string) {
  const encoded = protobuf_encode<SendLongMsgResp>({ result: { resId } });
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(encoded),
  };
}

describe('actions/forward', () => {
  it('uploadForwardNodes rejects empty arrays', async () => {
    const bridge = mockBridge();
    await expect(new ForwardApi(bridge as any).upload([]))
      .rejects.toThrow(/required/);
  });

  it('uploadForwardNodes dispatches to SsoSendLongMsg with a non-empty body and returns the res_id', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-001')) as any,
    });

    const resId = await new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'alice', elements: [] },
    ]);

    expect(resId).toBe('res-001');
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    const [serviceCmd, body] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.group.long_msg_interface.MsgService.SsoSendLongMsg');
    expect((body as Uint8Array).length).toBeGreaterThan(0);
  });

  it('uploadForwardNodes throws when sendRawPacket reports failure', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: false, gotResponse: false, errorCode: -1,
        errorMessage: 'pipe broken', responseData: null,
      })) as any,
    });
    await expect(new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'a', elements: [] },
    ])).rejects.toThrow(/pipe broken/);
  });

  it('uploadForwardNodes throws when the response is missing res_id', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('')) as any,
    });
    await expect(new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'a', elements: [] },
    ])).rejects.toThrow(/missing res_id/);
  });

  it('fetchForwardNodes serves from cache after a successful upload (no second sendRawPacket)', async () => {
    const sendRawPacket = vi.fn(async () => uploadResponseWithResId('res-cache')) as any;
    const bridge = mockBridge({ sendRawPacket });

    const nodes = [
      { userUin: 10001, nickname: 'alice', elements: [] },
      { userUin: 10002, nickname: 'bob', elements: [] },
    ];

    const resId = await new ForwardApi(bridge as any).upload(nodes);
    expect(resId).toBe('res-cache');

    const fetched = await new ForwardApi(bridge as any).fetch('res-cache');
    // Same nicknames + uins; elements have been deep-copied so the shape
    // is preserved but the array reference is different.
    expect(fetched).toHaveLength(2);
    expect(fetched.map((n: { nickname: string }) => n.nickname)).toEqual(['alice', 'bob']);
    expect(sendRawPacket).toHaveBeenCalledTimes(1);
  });

  it('fetchForwardNodes throws on transport failure when nothing is cached', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: false, gotResponse: false, errorCode: -1,
        errorMessage: 'down', responseData: null,
      })) as any,
    });
    await expect(new ForwardApi(bridge as any).fetch('cold-cache-miss'))
      .rejects.toThrow(/download forward message failed|down/);
  });

  it('uploadForwardNodes recursively uploads nested innerForward chains (NapCat piggyback model)', async () => {
    // Regression: nested forward needs the inner chain to be uploaded
    // first (so we have its res_id for the outer ARK preview), AND
    // the inner level's msgBody to be carried up to the outermost
    // long-msg upload as an extra `actionCommand` slot keyed on a
    // uuid. Matches `dev/NapCatQQ/.../SendMsg.uploadForwardedNodesPacket`
    // — the receiver gets the whole tree from a single fetch instead
    // of resolving each layer's res_id separately.
    const responses = ['inner-res', 'outer-res'];
    const sendRawPacket = vi.fn(async () => uploadResponseWithResId(responses.shift()!)) as any;
    const bridge = mockBridge({ sendRawPacket });

    const resId = await new ForwardApi(bridge as any).upload([
      {
        userUin: 111,
        nickname: 'outer',
        elements: [],
        innerForward: [
          { userUin: 222, nickname: 'inner', elements: [{ type: 'text', text: 'hi' }] },
        ],
      },
    ]);

    // Two server roundtrips: one for the inner chain, then one for
    // the outer (which piggybacks the inner msgBody onto its actions
    // array). The outer res_id is what the caller gets back.
    expect(resId).toBe('outer-res');
    expect(sendRawPacket).toHaveBeenCalledTimes(2);
  });

  it('uploadForwardNodes leaves flat (non-nested) sends at a single roundtrip', async () => {
    // Backwards-compat: the common case (no inner forward) must still
    // be one SsoSendLongMsg call. Without this we'd double upload
    // every regular forward send.
    const sendRawPacket = vi.fn(async () => uploadResponseWithResId('flat-res')) as any;
    const bridge = mockBridge({ sendRawPacket });

    const resId = await new ForwardApi(bridge as any).upload([
      { userUin: 10001, nickname: 'a', elements: [{ type: 'text', text: 'hello' }] },
      { userUin: 10002, nickname: 'b', elements: [{ type: 'text', text: 'world' }] },
    ]);

    expect(resId).toBe('flat-res');
    expect(sendRawPacket).toHaveBeenCalledOnce();
  });
});
