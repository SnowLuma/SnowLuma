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
import type { MentionExtra, SrcMsgPbReserve } from '@snowluma/proto-defs/element';

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

// Reply sequence: a reply's srcMsg.origSeqs[0] is the message sequence the
// original is keyed by — for BOTH group and c2c — so reply.id matches the
// replied-to message_id and get_msg(reply_id) resolves. Earlier code overrode
// c2c with pbReserve.friendSequence, but that's a small friend-relationship
// counter that does NOT match the original's head.sequence (e.g. 25 vs 12707),
// so reply.id != the quoted message_id and get_msg missed (the #114 / #124
// regression). Aligned with dev commit 839de51 — both group and c2c use
// origSeqs[0]; friendSequence is no longer read.
describe('decodeRichBody / reply uses origSeqs[0] for group and c2c', () => {
  const CLIENT_SEQ = 23188; // origSeqs[0] — the replied-to message's sequence
  const FRIEND_SEQ = 888;   // pbReserve.friendSequence — must be IGNORED (not the canonical seq)

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

  it('c2c: replySeq = origSeqs[0], friendSequence ignored', () => {
    expect(decodeRichBody(replyBody(), false)).toContainEqual({ type: 'reply', replySeq: CLIENT_SEQ });
  });

  it('group: replySeq = origSeqs[0], friendSequence ignored', () => {
    expect(decodeRichBody(replyBody(), true)).toContainEqual({ type: 'reply', replySeq: CLIENT_SEQ });
  });

  it('c2c without a reserve: falls back to origSeqs[0]', () => {
    const body: MessageBody = {
      richText: { elems: [{ srcMsg: { origSeqs: [CLIENT_SEQ] } } as any] },
    };
    expect(decodeRichBody(body, false)).toContainEqual({ type: 'reply', replySeq: CLIENT_SEQ });
  });
});

// #127: a group quoted reply is always followed by an "@<replied-to user>"
// anchor element that QQNT auto-inserts. On the wire it carries attr6Buf AND a
// pbReserve, so it used to be decoded as a genuine `[CQ:at]` segment — every
// reply surfaced a phantom @ plus an empty-text segment (#127). The anchor's
// MentionExtra.AtMemberUin (field4 = `uin`) is left at 0 (only `uid` is set);
// a real user-typed @mention fills `uin` with the target's real UIN. The
// decoder drops the first such `type=2 / uin=0` text elem right after srcMsg.
describe('decodeRichBody / reply anchor @ filter (#127)', () => {
  const REPLIED_UIN = 2894267324;
  const REPLIED_UID = 'u_AjZIs8j0pocxZrejdhpJNA';
  const REAL_AT_UIN = 3124975529;
  const REAL_AT_UID = 'u_someOtherRealUid000';

  // QQNT's attr6Buf shape: 13 bytes, target UIN is bytes[7..10] big-endian.
  // The decoder reads `me.targetUin` from there for backwards-compat clients
  // that only have attr6 (no pbReserve), and also to recover the UIN when the
  // real-@ case fills Attr6 but the mention.uin path isn't used.
  function attr6(targetUin: number): Uint8Array {
    const buf = new Uint8Array(13);
    buf[0] = 0x00; buf[1] = 0x01;
    buf[7] = (targetUin >>> 24) & 0xff;
    buf[8] = (targetUin >>> 16) & 0xff;
    buf[9] = (targetUin >>> 8) & 0xff;
    buf[10] = targetUin & 0xff;
    return buf;
  }

  // Anchor @: type=2, AtMemberUin=0, only uid filled — what QQNT inserts as the
  // reply prefix. Real @: type=2, AtMemberUin = real UIN.
  function atElem(display: string, targetUin: number, uid: string): any {
    return {
      text: {
        str: display,
        attr6Buf: attr6(targetUin),
        pbReserve: protobuf_encode<MentionExtra>({ type: 2, uin: targetUin, field5: 0, uid }),
      },
    };
  }

  it('drops the auto-inserted replied-to anchor @ (uin=0) right after srcMsg', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          { srcMsg: { origSeqs: [604118] } } as any,
          atElem('@月年', 0, REPLIED_UID),
          { text: { str: ' ' } } as any,
          { text: { str: '叼毛' } } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([
      { type: 'reply', replySeq: 604118 },
      { type: 'text', text: '叼毛' },
    ]);
  });

  it('keeps a genuine user @ (uin>0) after srcMsg and drops only the anchor', () => {
    // srcMsg + anchor@(replied-to, uin=0) + ' ' + real@(different user, uin>0) + body
    const body: MessageBody = {
      richText: {
        elems: [
          { srcMsg: { origSeqs: [604118] } } as any,
          atElem('@月年', 0, REPLIED_UID),
          { text: { str: ' ' } } as any,
          atElem('@CuberOOK', REAL_AT_UIN, REAL_AT_UID),
          { text: { str: ' 欧克' } } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([
      { type: 'reply', replySeq: 604118 },
      { type: 'at', text: '@CuberOOK', targetUin: REAL_AT_UIN, uid: REAL_AT_UID },
      { type: 'text', text: ' 欧克' },
    ]);
  });

  it('keeps a real @ that targets the replied-to user themselves (uin>0)', () => {
    // User replies to 月年 and then actually types @月年 themselves — the real
    // @ has uin=REPLIED_UIN (>0) so must survive; only the anchor (uin=0) is dropped.
    const body: MessageBody = {
      richText: {
        elems: [
          { srcMsg: { origSeqs: [11769] } } as any,
          atElem('@月年', 0, REPLIED_UID),
          { text: { str: ' ' } } as any,
          atElem('@月年', REPLIED_UIN, REPLIED_UID),
          { text: { str: ' hello' } } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([
      { type: 'reply', replySeq: 11769 },
      { type: 'at', text: '@月年', targetUin: REPLIED_UIN, uid: REPLIED_UID },
      { type: 'text', text: ' hello' },
    ]);
  });

  it('does not treat @all (type=1) as the reply anchor', () => {
    // @全体成员 has type=1 / uin=0 — it's a real segment, not the auto-anchor
    // (which is type=2). It must surface even when sitting right after srcMsg.
    const body: MessageBody = {
      richText: {
        elems: [
          { srcMsg: { origSeqs: [55] } } as any,
          {
            text: {
              str: '@全体成员 ',
              pbReserve: protobuf_encode<MentionExtra>({ type: 1, uin: 0, field5: 0, uid: 'all' }),
            },
          } as any,
          { text: { str: 'go' } } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toContainEqual({ type: 'at', text: '@全体成员 ', targetUin: 0, uid: 'all' });
    expect(out.find(e => e.type === 'at' && (e as any).uid === 'all')).toBeDefined();
  });

  it('drops a pure-whitespace text element so no empty [空消息] segment leaks', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          { text: { str: '   ' } } as any,
          { text: { str: 'keep' } } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([{ type: 'text', text: 'keep' }]);
  });
});
