import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/bridge/bridge-oidb', () => ({
  runOidb: vi.fn(async () => ({})),
}));

// element-builder reaches into protoEncode with element-specific schemas
// that we don't want to construct manually in tests; stub it to return
// a benign placeholder.
vi.mock('../../src/bridge/element-builder', () => ({
  buildSendElems: vi.fn(async () => []),
}));

import { protoEncode } from '../../src/protobuf/decode';
import { SendLongMsgRespSchema } from '../../src/bridge/proto/longmsg';
import * as forward from '../../src/bridge/actions/forward';
import { mockBridge } from './_helpers';

function uploadResponseWithResId(resId: string) {
  const encoded = protoEncode({ result: { resId } }, SendLongMsgRespSchema);
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
    await expect(forward.uploadForwardNodes(bridge as any, []))
      .rejects.toThrow(/required/);
  });

  it('uploadForwardNodes dispatches to SsoSendLongMsg with a non-empty body and returns the res_id', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('res-001')) as any,
    });

    const resId = await forward.uploadForwardNodes(bridge as any, [
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
    await expect(forward.uploadForwardNodes(bridge as any, [
      { userUin: 10001, nickname: 'a', elements: [] },
    ])).rejects.toThrow(/pipe broken/);
  });

  it('uploadForwardNodes throws when the response is missing res_id', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => uploadResponseWithResId('')) as any,
    });
    await expect(forward.uploadForwardNodes(bridge as any, [
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

    const resId = await forward.uploadForwardNodes(bridge as any, nodes);
    expect(resId).toBe('res-cache');

    const fetched = await forward.fetchForwardNodes(bridge as any, 'res-cache');
    // Same nicknames + uins; elements have been deep-copied so the shape
    // is preserved but the array reference is different.
    expect(fetched).toHaveLength(2);
    expect(fetched.map(n => n.nickname)).toEqual(['alice', 'bob']);
    expect(sendRawPacket).toHaveBeenCalledTimes(1);
  });

  it('fetchForwardNodes throws on transport failure when nothing is cached', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: false, gotResponse: false, errorCode: -1,
        errorMessage: 'down', responseData: null,
      })) as any,
    });
    await expect(forward.fetchForwardNodes(bridge as any, 'cold-cache-miss'))
      .rejects.toThrow(/download forward message failed|down/);
  });
});
