// Wire-byte alignment regression for nested forward upload — verifies
// that the OUTER LongMsgResult's `actions[]` carries:
//   - `{actionCommand: 'MultiMsg', actionData.msgBody: <outer nodes>}`
//   - `{actionCommand: <inner.uuid>, actionData.msgBody: <inner nodes>}`
// AND that the same uuid appears as `meta.detail.uniseq` inside the
// LightApp `com.tencent.multimsg` JSON of the outer's preview element
// pointing at the inner res_id.
//
// Without this alignment the QQ-NT recipient has no way to walk the
// piggyback — they see the inner preview's resid, look for a matching
// uniseq among the actions, find none, and either fall back to a fresh
// server fetch (extra latency) or render an empty bubble.
//
// Reference impls cross-checked:
//   dev/NapCatQQ/.../SendMsg.ts:208-347
//   dev/Lagrange.Core/.../Message/Entity/MultiMsgEntity.cs:43-115
//   dev/NapCatQQ/.../helper/forward-msg-builder.ts:52-122

import { describe, it, expect, vi } from 'vitest';
import { gunzipSync, inflateSync } from 'zlib';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SendLongMsgReq, SendLongMsgResp, LongMsgResult } from '@snowluma/proto-defs/longmsg';
import type { PushMsgBody } from '@snowluma/proto-defs/message';
import type { Elem } from '@snowluma/proto-defs/element';

// Don't mock element-builder — we WANT the real forward preview
// element to land in the encoded wire bytes so we can verify the
// `uniseq` round-trip against the piggyback's `actionCommand`.

// Mock highway uploads only — they're irrelevant for text-only nodes
// but the import would otherwise pull in the native ffmpeg addon.
vi.mock('@snowluma/protocol/highway/image-upload', () => ({
  uploadImageMsgInfo: vi.fn(async () => new Uint8Array()),
}));
vi.mock('@snowluma/protocol/highway/ptt-upload', () => ({
  uploadPttMsgInfo: vi.fn(async () => new Uint8Array()),
}));
vi.mock('@snowluma/protocol/highway/video-upload', () => ({
  uploadVideoMsgInfo: vi.fn(async () => new Uint8Array()),
}));

import { ForwardApi } from '../../src/bridge/apis/forward';
import { mockBridge } from './_helpers';

function uploadResponseWithResId(resId: string) {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(protobuf_encode<SendLongMsgResp>({ result: { resId } })),
  };
}

function decodeOuterLongMsg(rawBytes: Uint8Array): LongMsgResult {
  const env = protobuf_decode<SendLongMsgReq>(rawBytes);
  const payload = env.info?.payload;
  if (!(payload instanceof Uint8Array)) throw new Error('payload missing on the SendLongMsgReq');
  return protobuf_decode<LongMsgResult>(gunzipSync(Buffer.from(payload)));
}

function findLightAppJson(msgBody: PushMsgBody[]): { resid?: string; uniseq?: string; app?: string } | null {
  for (const body of msgBody) {
    const elems: Elem[] = body.body?.richText?.elems ?? [];
    for (const elem of elems) {
      if (elem.lightApp?.data && elem.lightApp.data.length > 1) {
        const data = elem.lightApp.data;
        if (data[0] !== 0x01) continue;
        try {
          const json = inflateSync(Buffer.from(data.subarray(1))).toString('utf8');
          const parsed = JSON.parse(json);
          if (parsed?.app === 'com.tencent.multimsg') {
            return {
              app: parsed.app,
              resid: parsed.meta?.detail?.resid,
              uniseq: parsed.meta?.detail?.uniseq,
            };
          }
        } catch { /* ignore */ }
      }
    }
  }
  return null;
}

describe('forward / nested upload wire alignment', () => {
  it('outer LongMsgResult contains both MultiMsg and the inner uuid piggyback action', async () => {
    // Inner upload returns inner-res; outer upload returns outer-res.
    const responses = ['inner-res', 'outer-res'];
    const sendRawPacket = vi.fn(async () =>
      uploadResponseWithResId(responses.shift()!)) as any;
    const bridge = mockBridge({ sendRawPacket });

    const resId = await new ForwardApi(bridge as any).upload([
      {
        userUin: 111, nickname: 'outer', elements: [],
        innerForward: [
          { userUin: 222, nickname: 'inner', elements: [{ type: 'text', text: 'hi' }] },
        ],
      },
    ]);

    expect(resId).toBe('outer-res');
    expect(sendRawPacket).toHaveBeenCalledTimes(2);

    // Second call is the OUTER's upload (the inner went first).
    const outerBytes = sendRawPacket.mock.calls[1]![1] as Uint8Array;
    const outerLongMsg = decodeOuterLongMsg(outerBytes);

    const actions = outerLongMsg.action ?? [];
    expect(actions).toHaveLength(2);
    expect(actions[0]!.actionCommand).toBe('MultiMsg');
    // The second action carries the inner's msgBody under a uuid
    // actionCommand (NOT 'MultiMsg').
    const piggybackUuid = actions[1]!.actionCommand!;
    expect(piggybackUuid).not.toBe('MultiMsg');
    expect(piggybackUuid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(actions[1]!.actionData?.msgBody?.length ?? 0).toBeGreaterThan(0);
  });

  it('outer preview LightApp uniseq matches the piggyback actionCommand uuid', async () => {
    // This is the alignment bug: without it the QQ-NT receiver
    // can't link the inner preview to its piggyback in actions[].
    const responses = ['inner-res-A', 'outer-res-A'];
    const sendRawPacket = vi.fn(async () =>
      uploadResponseWithResId(responses.shift()!)) as any;
    const bridge = mockBridge({ sendRawPacket });

    await new ForwardApi(bridge as any).upload([
      {
        userUin: 111, nickname: 'outer', elements: [],
        innerForward: [
          { userUin: 222, nickname: 'inner', elements: [{ type: 'text', text: 'hi' }] },
        ],
      },
    ]);

    const outerBytes = sendRawPacket.mock.calls[1]![1] as Uint8Array;
    const outerLongMsg = decodeOuterLongMsg(outerBytes);

    const piggybackUuid = outerLongMsg.action![1]!.actionCommand!;
    const outerMsgBody = outerLongMsg.action![0]!.actionData!.msgBody!;
    const preview = findLightAppJson(outerMsgBody);

    expect(preview).not.toBeNull();
    expect(preview!.app).toBe('com.tencent.multimsg');
    expect(preview!.resid).toBe('inner-res-A');
    expect(preview!.uniseq).toBe(piggybackUuid);
  });

  it('three-deep nesting: outermost action[] carries 1+2 entries (MultiMsg + 2 piggybacks)', async () => {
    // The middle level's upload produces 1 MultiMsg + 1 piggyback
    // (for the deepest). The outermost level then concatenates its
    // own MultiMsg + the middle's piggyback set, so action[].length = 3.
    const responses = ['deepest', 'middle', 'outermost'];
    const sendRawPacket = vi.fn(async () =>
      uploadResponseWithResId(responses.shift()!)) as any;
    const bridge = mockBridge({ sendRawPacket });

    await new ForwardApi(bridge as any).upload([
      {
        userUin: 1, nickname: 'L1', elements: [],
        innerForward: [{
          userUin: 2, nickname: 'L2', elements: [],
          innerForward: [
            { userUin: 3, nickname: 'L3', elements: [{ type: 'text', text: 'deep' }] },
          ],
        }],
      },
    ]);

    expect(sendRawPacket).toHaveBeenCalledTimes(3);
    const outermostBytes = sendRawPacket.mock.calls[2]![1] as Uint8Array;
    const outermost = decodeOuterLongMsg(outermostBytes);
    expect(outermost.action).toHaveLength(3);
    expect(outermost.action![0]!.actionCommand).toBe('MultiMsg');
    expect(outermost.action![1]!.actionCommand).not.toBe('MultiMsg');
    expect(outermost.action![2]!.actionCommand).not.toBe('MultiMsg');
    expect(outermost.action![1]!.actionCommand).not.toBe(outermost.action![2]!.actionCommand);
  });
});
