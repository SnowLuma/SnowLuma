// Receive-side decode for `com.tencent.multimsg` LightApp — verifies
// the inverse of element-builder.makeForwardElem so a forward sent by
// SnowLuma (or any QQ-NT / Lagrange / NapCat client) round-trips
// back to `{type: 'forward', resId, forwardUuid}` on the receiver.
//
// Without this the receiver-side decoder sees `lightApp` and falls
// back to a generic `{type: 'json', text: <json>}` element, which
// means the OneBot layer can't surface a forward bubble OR walk into
// the nested forward via fetch(resId).

import { describe, expect, it } from 'vitest';
import { deflateSync } from 'zlib';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { decodeRichBody } from '../../src/msg-push/rich-body-decoder';
import { buildSendElems } from '../../src/element-builder';
import type { MessageElement } from '../../src/events';
import type { MessageBody } from '@snowluma/proto-defs/message';
import type { SrcMsgPbReserve } from '@snowluma/proto-defs/element';

function lightAppBytes(json: unknown): Uint8Array {
  const buf = deflateSync(Buffer.from(JSON.stringify(json), 'utf8'));
  const out = new Uint8Array(buf.length + 1);
  out[0] = 0x01;  // deflate prefix
  out.set(buf, 1);
  return out;
}

describe('decodeRichBody / forward LightApp', () => {
  it('emits {type:"forward", resId, forwardUuid} for com.tencent.multimsg', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            lightApp: {
              data: lightAppBytes({
                app: 'com.tencent.multimsg',
                meta: { detail: { resid: 'inner-res-1', uniseq: 'uuid-1' } },
              }),
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([{ type: 'forward', resId: 'inner-res-1', forwardUuid: 'uuid-1' }]);
  });

  it('omits forwardUuid when the sender did not set uniseq (XML-era forwards)', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            lightApp: {
              data: lightAppBytes({
                app: 'com.tencent.multimsg',
                meta: { detail: { resid: 'only-resid' } },
              }),
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([{ type: 'forward', resId: 'only-resid' }]);
  });

  it('falls back to {type:"json"} for non-multimsg LightApp (e.g. mini-app card)', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            lightApp: {
              data: lightAppBytes({ app: 'com.tencent.miniapp_01', meta: {} }),
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('json');
    expect(typeof (out[0] as any).text).toBe('string');
  });

  // [#146] A QQ mini-program / ark share (e.g. a B站 video card) arrives as a
  // `lightApp` ark element followed by a plain `text` element carrying QQ's
  // graceful-degradation compat string ("当前QQ版本不支持此应用，请升级") — the
  // text the protocol attaches for clients too old to render the ark. QQ NT and
  // the kernel-backed bridges (NapCat) drop it and surface only the card. The
  // captured wire is exactly: [lightApp, text(fallback), generalFlags, {}, extraInfo].
  it('[#146] drops QQ ark-compat fallback text sibling of a mini-app card', () => {
    const ark = {
      app: 'com.tencent.miniapp_01',
      prompt: '[QQ小程序]【危机合约】平民3人50',
      meta: { detail_1: { appid: '1109937557', title: '哔哩哔哩', desc: '【危机合约】平民3人50' } },
    };
    const body: MessageBody = {
      richText: {
        elems: [
          { lightApp: { data: lightAppBytes(ark) } } as any,
          { text: { str: '当前QQ版本不支持此应用，请升级' } } as any,
          { generalFlags: {} } as any,
          {} as any,
          { extraInfo: {} } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('json');
    expect(JSON.parse((out[0] as any).text).meta.detail_1.title).toBe('哔哩哔哩');
  });

  // RE of wrapper.linux.node confirmed QQ's kernel codec (msg_codec_mgr) has no
  // fallback strings and collapses a card message to a single ark element —
  // ANY sibling plain text is dropped, not just the known compat string. We
  // mirror that structural rule rather than content-matching (which would break
  // when Tencent reworded the string). NapCat shows the same: it maps kernel
  // elements 1:1, and the kernel already dropped the text.
  it('[#146] drops any sibling plain text beside a card (structural, matches QQ kernel)', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          { lightApp: { data: lightAppBytes({ app: 'com.tencent.miniapp_01', meta: {} }) } } as any,
          { text: { str: '快看这个视频' } } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out.map((e) => e.type)).toEqual(['json']);
  });

  // Scope guard: only PLAIN text is dropped beside a card. A real @ mention
  // (non-zero uin) is not plain text and must survive.
  it('[#146] keeps a genuine @ mention beside a card', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          { lightApp: { data: lightAppBytes({ app: 'com.tencent.miniapp_01', meta: {} }) } } as any,
          { text: { str: '@someone', attr6Buf: new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0x12, 0x34, 0x56, 0x78, 0]) } } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out.map((e) => e.type)).toEqual(['json', 'at']);
  });

  it('falls back to {type:"json"} when com.tencent.multimsg is missing resid (malformed)', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            lightApp: {
              data: lightAppBytes({
                app: 'com.tencent.multimsg',
                meta: { detail: {} },
              }),
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('json');
  });

  it('still decodes the legacy richMsg serviceID=35 path (backward compat with mobile QQ)', () => {
    // Older clients (and some bridges) still emit the m_resid XML
    // shape. The decoder must keep treating it as a forward element
    // so SnowLuma can fetch the resid downstream.
    const xml = '<?xml version="1.0"?><msg m_resid="legacy-res" />';
    const xmlBuf = new Uint8Array(xml.length + 1);
    xmlBuf[0] = 0x00;
    xmlBuf.set(new TextEncoder().encode(xml), 1);

    const body: MessageBody = {
      richText: {
        elems: [
          {
            richMsg: { serviceId: 35, template1: xmlBuf },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'forward', resId: 'legacy-res' });
  });
});

// Market face (商城表情): decode the wire `marketFace` element into the
// `emoji_id`/`emoji_package_id`/`key` markers, and round-trip an mface element
// back through the real proton codegen (faceId hex bytes + pbReserve) so a
// sticker SnowLuma re-sends decodes identically on the receiver.
describe('decodeRichBody / market face', () => {
  const EMOJI_ID = '235a82d9c0acd2e2db6e0b94e1a1c4f3';

  it('decodes a wire marketFace into an mface element (emojiId = lowercase hex of faceId)', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            marketFace: {
              faceName: '可爱',
              faceId: Buffer.from(EMOJI_ID, 'hex'),
              tabId: 12,
              key: 'abc',
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([{
      type: 'mface', text: '可爱', emojiId: EMOJI_ID, emojiPackageId: 12, emojiKey: 'abc',
    }]);
  });

  it('round-trips an mface element → wire → element through real proton codegen', async () => {
    const el: MessageElement = {
      type: 'mface', text: '可爱', emojiId: EMOJI_ID, emojiPackageId: 12, emojiKey: 'abc',
    };
    const elems = await buildSendElems([el]);
    const wire = protobuf_encode<MessageBody>({ richText: { elems: elems as any } });
    const decoded = protobuf_decode<MessageBody>(wire);
    expect(decodeRichBody(decoded, true)).toEqual([el]);
  });
});

// Reply identity for c2c: the replied-to sequence is srcMsg.origSeqs[0] for BOTH
// group and c2c. On-target capture (#114 / #124) proved origSeqs[0] equals the
// quoted message's head.sequence — i.e. the seq its message_id is hashed from —
// while pbReserve.friendSequence is a small friend-relationship counter that does
// NOT match (e.g. 25 vs a head.sequence of 12707). Reading friendSequence made
// reply.id != the quoted message_id, so get_msg(reply_id) missed.
describe('decodeRichBody / reply uses origSeqs[0] for c2c', () => {
  const CLIENT_SEQ = 23188; // origSeqs[0] — the quoted message's head.sequence
  const FRIEND_SEQ = 888;   // pbReserve.friendSequence — a small unrelated counter, ignored

  function replyBody(): MessageBody {
    return {
      richText: {
        elems: [
          {
            srcMsg: {
              origSeqs: [CLIENT_SEQ],
              pbReserve: protobuf_encode<SrcMsgPbReserve>({ friendSequence: FRIEND_SEQ }),
            },
          } as any,
        ],
      },
    };
  }

  it('c2c: replySeq = origSeqs[0], not friendSequence (#114/#124)', () => {
    expect(decodeRichBody(replyBody(), false)).toContainEqual({ type: 'reply', replySeq: CLIENT_SEQ });
    expect(FRIEND_SEQ).not.toBe(CLIENT_SEQ); // guard: the two must differ for this to mean anything
  });

  it('group: replySeq = origSeqs[0] (friendSequence ignored)', () => {
    expect(decodeRichBody(replyBody(), true)).toContainEqual({ type: 'reply', replySeq: CLIENT_SEQ });
  });

  it('c2c without a reserve: falls back to origSeqs[0]', () => {
    const body: MessageBody = {
      richText: { elems: [{ srcMsg: { origSeqs: [CLIENT_SEQ] } } as any] },
    };
    expect(decodeRichBody(body, false)).toContainEqual({ type: 'reply', replySeq: CLIENT_SEQ });
  });
});
