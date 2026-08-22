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
import { getLogLevel, setLogLevel, subscribeLogs } from '@snowluma/common/logger';
import { decodeRichBody, hasDecodableContent } from '../../src/msg-push/rich-body-decoder';
import { MAX_RICH_CARD_OUTPUT_BYTES } from '../../src/msg-push/helpers';
import { buildSendElems } from '../../src/element-builder';
import { assertValidMessageElement } from '../../src/element-manifest';
import type { MessageElement } from '../../src/events';
import type { MessageBody } from '@snowluma/proto-defs/message';
import type {
  Elem,
  MsgInfo,
  QFaceExtra,
  SrcMsgPbReserve,
  TextElem,
} from '@snowluma/proto-defs/element';
import { imageUrlFromMd5, makeImageUrl, ntImageUrlFromFileId } from '../../src/msg-push/helpers';

function lightAppBytes(json: unknown): Uint8Array {
  const buf = deflateSync(Buffer.from(JSON.stringify(json), 'utf8'));
  const out = new Uint8Array(buf.length + 1);
  out[0] = 0x01;  // deflate prefix
  out.set(buf, 1);
  return out;
}

function varint(value: number): number[] {
  const out: number[] = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    out.push(byte);
  } while (current !== 0);
  return out;
}

function lengthDelimited(fieldNumber: number, payload: Uint8Array): Uint8Array {
  return Uint8Array.from([
    ...varint((fieldNumber << 3) | 2),
    ...varint(payload.length),
    ...payload,
  ]);
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

describe('decodeRichBody / decoded element contract', () => {
  it('[#291] prefers a decoded C2C media record over the empty legacy PTT placeholder', () => {
    const fileHash = '469e23ff66ae3ebbf4c78d616e0df18b';
    const fileSha1 = 'a00c7fbe3bfa92773ae17a2f6d381375810972e2';
    const encoded = protobuf_encode<MessageBody>({
      richText: {
        elems: [{
          commonElem: {
            serviceType: 48,
            businessType: 22,
            pbElem: protobuf_encode<MsgInfo>({
              msgInfoBody: [{
                index: {
                  fileUuid: 'voice-uuid',
                  storeId: 1,
                  uploadTime: 1785116936,
                  ttl: 604800,
                  info: {
                    fileName: `${fileHash}.amr`,
                    fileSize: 2015,
                    fileHash,
                    fileSha1,
                    time: 1,
                    type: { type: 3, voiceFormat: 1 },
                  },
                },
              }],
            }),
          },
        }],
        ptt: {},
      },
    });

    const out = decodeRichBody(protobuf_decode<MessageBody>(encoded), false);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'record',
      fileName: `${fileHash}.amr`,
      fileId: 'voice-uuid',
      fileSize: 2015,
      duration: 1,
      voiceFormat: 1,
      md5Hex: fileHash,
      sha1Hex: fileSha1,
    });
  });

  it('omits an absent PTT fingerprint instead of emitting an invalid empty hash', () => {
    const body: MessageBody = {
      richText: {
        ptt: {
          fileName: 'voice.silk',
          fileSize: 12,
          time: 1,
          fileMd5: new Uint8Array(),
        },
      },
    } as any;
    const out = decodeRichBody(body, true);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('md5Hex');
    expect(() => assertValidMessageElement(out[0], 'D')).not.toThrow();
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

describe('decodeRichBody / unknown wire element observability', () => {
  it('does not report Proton materialized null fields as wire elements', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const encoded = protobuf_encode<MessageBody>({
        richText: { elems: [{ text: { str: 'known text' } }] },
      });
      const decodedBody = protobuf_decode<MessageBody>(encoded);
      expect(decodeRichBody(decodedBody, true)).toEqual([{ type: 'text', text: 'known text' }]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured.filter((entry) => entry.scope === 'MsgPush.UnknownElement')).toEqual([]);
  });

  it('records a service-48 CommonElem with an unknown business type', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const body: MessageBody = {
        richText: {
          elems: [{
            commonElem: {
              serviceType: 48,
              businessType: 99,
              pbElem: protobuf_encode<MsgInfo>({}),
            },
          }],
        },
      };
      expect(decodeRichBody(body, true)).toEqual([]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining(
        'serviceType=48 businessType=99 reason=no recognized MessageElement payload',
      ),
    }));
  });

  it('fails open and records the unsupported wire field plus reason', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const body: MessageBody = {
        richText: {
          elems: [{ onlineImage: { filePath: '/unknown-wire-shape' } } as any],
        },
      };
      let decoded: ReturnType<typeof decodeRichBody> | undefined;
      expect(() => { decoded = decodeRichBody(body, true); }).not.toThrow();
      expect(decoded).toEqual([]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining('fields=onlineImage reason=no MessageElement decoder'),
    }));
  });

  it('retains and records a schema-unknown protobuf tag beside known text', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const knownElem = protobuf_encode<Elem>({
        text: { str: 'known text' },
      });
      const unknownElem = lengthDelimited(60, Uint8Array.of(1, 2, 3));
      const richText = Uint8Array.from([
        ...lengthDelimited(2, knownElem),
        ...lengthDelimited(2, unknownElem),
      ]);
      const rawBody = lengthDelimited(1, richText);
      const decodedBody = protobuf_decode<MessageBody>(rawBody);

      expect(decodeRichBody(decodedBody, true)).toEqual([{ type: 'text', text: 'known text' }]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining(
        'unknownTag=60 wireType=2 count=1 bytes=4 reason=no schema decoder path=elem',
      ),
    }));
  });

  it('logs repeated unknown tags once with an occurrence count', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const elemBytes: number[] = [...protobuf_encode<Elem>({ text: { str: 'known' } })];
      const unknown = lengthDelimited(60, Uint8Array.of(7));
      for (let index = 0; index < 1_000; index++) elemBytes.push(...unknown);
      const richText = lengthDelimited(2, Uint8Array.from(elemBytes));
      const decodedBody = protobuf_decode<MessageBody>(lengthDelimited(1, richText));

      expect(decodeRichBody(decodedBody, true)).toEqual([{ type: 'text', text: 'known' }]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    const logs = captured.filter((entry) => entry.message.includes('unknownTag=60'));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toContain('count=1000 bytes=2000');
  });

  it('preserves sibling text and records a malformed known card field', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const body: MessageBody = {
        richText: {
          elems: [
            { richMsg: { serviceId: 35, template1: Uint8Array.of(1, 1, 2, 3) } } as any,
            { text: { str: 'keep me' } } as any,
          ],
        },
      };
      expect(decodeRichBody(body, true)).toEqual([{ type: 'text', text: 'keep me' }]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining('fields=richMsg reason=no recognized MessageElement payload'),
    }));
  });

  it('does not consume the next element when a structural CommonElem is malformed', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          { commonElem: { serviceType: 3, businessType: 0, pbElem: Uint8Array.of(0, 5) } } as any,
          { text: { str: 'keep next' } } as any,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([{ type: 'text', text: 'keep next' }]);
  });

  it('[#289] drops a big-face compatibility text identified by its nested Text reserve', () => {
    const compatibilityReserve = protobuf_encode<TextElem>({
      str: '[打call]请使用最新版手机QQ体验新功能',
    });
    // Issue #289 logged field 1 as bytes=51: one length byte plus the
    // 50-byte UTF-8 compatibility string (the protobuf field key is separate).
    expect(compatibilityReserve).toHaveLength(52);

    const body: MessageBody = {
      richText: {
        elems: [
          {
            commonElem: {
              serviceType: 37,
              businessType: 1,
              pbElem: protobuf_encode<QFaceExtra>({
                qsid: 311,
                text: '/打call',
              }),
            },
          } as any,
          {
            text: {
              str: '/打call',
              pbReserve: compatibilityReserve,
            },
          } as any,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'face', faceId: 311 },
    ]);
  });

  it('does not consume sibling user text after a decoded big face', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            commonElem: {
              serviceType: 37,
              businessType: 0,
              pbElem: protobuf_encode<QFaceExtra>({ qsid: 321, text: '/same text' }),
            },
          } as any,
          { text: { str: '/same text' } } as any,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'face', faceId: 321 },
      { type: 'text', text: '/same text' },
    ]);
  });

  it('[#289] preserves compatibility text when the big face has no valid face id', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            commonElem: {
              serviceType: 37,
              businessType: 1,
              pbElem: protobuf_encode<QFaceExtra>({ text: '/打call' }),
            },
          } as any,
          {
            text: {
              str: '/打call',
              pbReserve: protobuf_encode<TextElem>({
                str: '[打call]请使用最新版手机QQ体验新功能',
              }),
            },
          } as any,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'text', text: '/打call' },
    ]);
  });

  it('[#289] suppresses only compatibility text and decodes other fields in the same element', () => {
    const compatibilityReserve = protobuf_encode<TextElem>({
      str: '[打call]请使用最新版手机QQ体验新功能',
    });
    const body: MessageBody = {
      richText: {
        elems: [
          {
            commonElem: {
              serviceType: 37,
              businessType: 1,
              pbElem: protobuf_encode<QFaceExtra>({ qsid: 311, text: '/打call' }),
            },
          } as any,
          {
            text: { str: '/打call', pbReserve: compatibilityReserve },
            face: { index: 14 },
          } as any,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'face', faceId: 311 },
      { type: 'face', faceId: 14 },
    ]);
  });

  it('[#289] preserves text when the nested reserve has extra wire fields', () => {
    const canonical = protobuf_encode<TextElem>({
      str: '[打call]请使用最新版手机QQ体验新功能',
    });
    const nonCanonical = Uint8Array.from([...canonical, 0x12, 0x00]);
    const body: MessageBody = {
      richText: {
        elems: [
          {
            commonElem: {
              serviceType: 37,
              businessType: 1,
              pbElem: protobuf_encode<QFaceExtra>({ qsid: 311, text: '/打call' }),
            },
          } as any,
          { text: { str: '/打call', pbReserve: nonCanonical } } as any,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'face', faceId: 311 },
      { type: 'text', text: '/打call' },
    ]);
  });

  it('[#289] preserves sibling text when its nested reserve is not QQ compatibility text', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            commonElem: {
              serviceType: 37,
              businessType: 1,
              pbElem: protobuf_encode<QFaceExtra>({ qsid: 311, text: '/打call' }),
            },
          } as any,
          {
            text: {
              str: '/打call',
              pbReserve: protobuf_encode<TextElem>({ str: '[打call]ordinary metadata' }),
            },
          } as any,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'face', faceId: 311 },
      { type: 'text', text: '/打call' },
    ]);
  });

  it('records unknown tags inside bytes-embedded protobuf payloads', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const known = protobuf_encode<QFaceExtra>({ qsid: 654 });
      const pbElem = Uint8Array.from([
        ...known,
        ...lengthDelimited(60, Uint8Array.of(1, 2)),
      ]);
      const body: MessageBody = {
        richText: {
          elems: [{
            commonElem: { serviceType: 37, businessType: 0, pbElem },
          } as any],
        },
      };

      expect(decodeRichBody(body, true)).toEqual([{ type: 'face', faceId: 654 }]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      message: expect.stringContaining(
        'unknownTag=60 wireType=2 count=1 bytes=3 reason=no schema decoder path=commonElem.bigFace',
      ),
    }));
  });

  it('fails open when an embedded face protobuf is truncated', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const body: MessageBody = {
        richText: {
          elems: [
            {
              commonElem: {
                serviceType: 37,
                businessType: 0,
                pbElem: Uint8Array.of(0x18, 0x80),
              },
            } as any,
            { text: { str: 'keep after malformed face' } } as any,
          ],
        },
      };

      let decoded: ReturnType<typeof decodeRichBody> | undefined;
      expect(() => { decoded = decodeRichBody(body, true); }).not.toThrow();
      expect(decoded).toEqual([
        { type: 'text', text: 'keep after malformed face' },
      ]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining(
        'source=commonElem.bigFace bytes=2 reason=protobuf_truncated',
      ),
    }));
  });

  it('retains and records schema-unknown tags inside nested element messages', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const textPayload = Uint8Array.from([
        ...lengthDelimited(1, new TextEncoder().encode('nested known text')),
        ...lengthDelimited(60, Uint8Array.of(9, 8, 7)),
      ]);
      const elemPayload = lengthDelimited(1, textPayload);
      const richTextPayload = lengthDelimited(2, elemPayload);
      const decodedBody = protobuf_decode<MessageBody>(lengthDelimited(1, richTextPayload));

      expect(decodeRichBody(decodedBody, true)).toEqual([
        { type: 'text', text: 'nested known text' },
      ]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining(
        'unknownTag=60 wireType=2 count=1 bytes=4 reason=no schema decoder path=elem.text',
      ),
    }));
  });

  it('preserves sibling text when a LightApp is not a JSON object', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const body: MessageBody = {
        richText: {
          elems: [
            {
              lightApp: {
                data: Uint8Array.from([0, ...Buffer.from('not-json', 'utf8')]),
              },
            } as any,
            { text: { str: 'keep me' } } as any,
          ],
        },
      };

      expect(decodeRichBody(body, true)).toEqual([{ type: 'text', text: 'keep me' }]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining('wire light card ignored inputBytes=9 reason=invalid_json'),
    }));
    expect(captured.some((entry) => entry.message.includes('not-json'))).toBe(false);
  });

  it('records unknown tags on MessageBody and RichText roots', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const knownElem = protobuf_encode<Elem>({ text: { str: 'root known text' } });
      const richTextPayload = Uint8Array.from([
        ...lengthDelimited(2, knownElem),
        ...lengthDelimited(61, Uint8Array.of(4, 5)),
      ]);
      const rawBody = Uint8Array.from([
        ...lengthDelimited(1, richTextPayload),
        ...lengthDelimited(60, Uint8Array.of(6)),
      ]);
      const decodedBody = protobuf_decode<MessageBody>(rawBody);

      expect(decodeRichBody(decodedBody, true)).toEqual([
        { type: 'text', text: 'root known text' },
      ]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('unknownTag=60 wireType=2 count=1 bytes=2 reason=no schema decoder path=body'),
    }));
    expect(captured).toContainEqual(expect.objectContaining({
      message: expect.stringContaining('unknownTag=61 wireType=2 count=1 bytes=3 reason=no schema decoder path=body.richText'),
    }));
  });

  it('does not treat marker-only or non-XML RichMsg data as a card', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          { richMsg: { serviceId: 35, template1: Uint8Array.of(0) } } as any,
          {
            richMsg: {
              serviceId: 35,
              template1: Uint8Array.from([0, ...Buffer.from('not xml', 'utf8')]),
            },
          } as any,
          { text: { str: 'keep malformed card fallback' } } as any,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'text', text: 'keep malformed card fallback' },
    ]);
  });

  it('bounds compressed card output and preserves sibling text on overflow', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const compressed = deflateSync(Buffer.alloc(MAX_RICH_CARD_OUTPUT_BYTES + 1, 0x61));
      const data = new Uint8Array(compressed.length + 1);
      data[0] = 1;
      data.set(compressed, 1);
      const body: MessageBody = {
        richText: {
          elems: [
            { lightApp: { data } } as any,
            { text: { str: 'bounded fallback' } } as any,
          ],
        },
      };

      expect(decodeRichBody(body, true)).toEqual([
        { type: 'text', text: 'bounded fallback' },
      ]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining('reason=output_limit_exceeded'),
    }));
  });

  function ntImageElem(fileName: string): Elem {
    const msgInfo: MsgInfo = {
      msgInfoBody: [{
        index: {
          info: {
            fileSize: 10711,
            fileHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            fileSha1: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            fileName,
            width: 1080,
            height: 1080,
            type: { picFormat: 1001 },
          },
        },
        picture: {
          urlPath: '/download?appid=1407&fileid=EhRgood',
          domain: 'multimedia.nt.qq.com.cn',
          ext: { originalParameter: '&rkey=good' },
        },
      }],
      extBizInfo: { pic: { bizType: 0, textSummary: '[图片]' } },
    };
    return {
      commonElem: {
        serviceType: 48,
        businessType: 20,
        pbElem: protobuf_encode<MsgInfo>(msgInfo),
      },
    };
  }

  function customFaceElem(filePath: string, origUrl: string, md5: Uint8Array): Elem {
    return {
      customFace: {
        filePath,
        origUrl,
        md5,
        size: 10711,
        width: 1080,
        height: 1080,
      },
    };
  }

  describe('decodeRichBody / NT image compatibility siblings (#389)', () => {
    const fileName = 'bcc7bbcc76a1a9d940c57346a5d223e8.png';
    const otherMd5 = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

    it('keeps the NT image and drops the query-only customFace sibling', () => {
      const out = decodeRichBody({
        richText: {
          elems: [
            ntImageElem(fileName),
            customFaceElem(fileName, '&rkey=xxx&spec=0', otherMd5),
          ],
        },
      }, true);

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: 'image',
        fileId: fileName,
        imageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhRgood&rkey=good',
        picFormat: 1001,
      });
    });

    it('drops a same-file customFace even when its legacy URL is well-formed', () => {
      const out = decodeRichBody({
        richText: {
          elems: [
            ntImageElem(fileName),
            customFaceElem(fileName, '/gchatpic_new/0/0-0-AABB/0', otherMd5),
          ],
        },
      }, true);

      expect(out).toEqual([
        expect.objectContaining({ type: 'image', fileId: fileName, picFormat: 1001 }),
      ]);
    });

    it('keeps a standalone customFace with a usable download path', () => {
      const out = decodeRichBody({
        richText: {
          elems: [customFaceElem(fileName, '/gchatpic_new/0/0-0-AABB/0', otherMd5)],
        },
      }, true);

      expect(out).toEqual([{
        type: 'image',
        imageUrl: 'http://gchat.qpic.cn/gchatpic_new/0/0-0-AABB/0',
        fileId: fileName,
        fileSize: 10711,
        width: 1080,
        height: 1080,
        subType: 0,
        summary: '[图片]',
        md5Hex: '0102030405060708090A0B0C0D0E0F10',
      }]);
    });

    it('drops a standalone customFace whose URL cannot be fetched', () => {
      const out = decodeRichBody({
        richText: {
          elems: [customFaceElem(fileName, '&rkey=xxx&spec=0', otherMd5)],
        },
      }, true);

      expect(out).toEqual([]);
    });

    it('rebuilds a download URL from md5 when a customFace has no path', () => {
      const out = decodeRichBody({
        richText: {
          elems: [customFaceElem(fileName, '', otherMd5)],
        },
      }, true);

      expect(out).toEqual([{
        type: 'image',
        imageUrl: 'http://gchat.qpic.cn/gchatpic_new/0/0-0-0102030405060708090A0B0C0D0E0F10/0',
        fileId: fileName,
        fileSize: 10711,
        width: 1080,
        height: 1080,
        subType: 0,
        summary: '[图片]',
        md5Hex: '0102030405060708090A0B0C0D0E0F10',
      }]);
    });

    it('rebuilds an NT download URL from file id when the path is omitted', () => {
      const msgInfo: MsgInfo = {
        msgInfoBody: [{
          index: {
            fileUuid: 'EhRforward',
            info: {
              fileSize: 10711,
              fileHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              fileSha1: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              fileName: '',
              width: 1080,
              height: 1080,
              type: { picFormat: 1001 },
            },
          },
        }],
        extBizInfo: { pic: { bizType: 0, textSummary: '[图片]' } },
      };
      const out = decodeRichBody({
        richText: {
          elems: [{
            commonElem: {
              serviceType: 48,
              businessType: 20,
              pbElem: protobuf_encode<MsgInfo>(msgInfo),
            },
          }],
        },
      }, true);

      expect(out).toEqual([expect.objectContaining({
        type: 'image',
        fileId: 'EhRforward',
        imageUrl: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhRforward',
        summary: '[图片]',
      })]);
    });

    it('keeps two distinct pictures', () => {
      const second = 'other.png';
      const out = decodeRichBody({
        richText: {
          elems: [
            ntImageElem(fileName),
            customFaceElem(second, '/gchatpic_new/0/0-0-CCDD/0', otherMd5),
          ],
        },
      }, true);

      expect(out.map((el) => el.type === 'image' ? el.fileId : el.type)).toEqual([
        fileName,
        second,
      ]);
    });
  });

  describe('makeImageUrl', () => {
    it('prefixes NT paths that already include a download path', () => {
      expect(makeImageUrl('/download?appid=1407&fileid=abc&rkey=x'))
        .toBe('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=abc&rkey=x');
    });

    it('does not glue the NT host onto a query fragment (#389)', () => {
      expect(makeImageUrl('&rkey=xxx&spec=0')).toBe('');
      expect(makeImageUrl('rkey=xxx&spec=0')).toBe('');
    });

    it('prefixes legacy gchat paths', () => {
      expect(makeImageUrl('/gchatpic_new/0/0-0-AABB/0'))
        .toBe('http://gchat.qpic.cn/gchatpic_new/0/0-0-AABB/0');
    });

    it('rebuilds a gchat URL from a 32-char md5', () => {
      expect(imageUrlFromMd5('0102030405060708090a0b0c0d0e0f10'))
        .toBe('http://gchat.qpic.cn/gchatpic_new/0/0-0-0102030405060708090A0B0C0D0E0F10/0');
      expect(imageUrlFromMd5('short')).toBe('');
    });

    it('rebuilds an NT URL from a file id', () => {
      expect(ntImageUrlFromFileId('EhRforward', true))
        .toBe('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=EhRforward');
      expect(ntImageUrlFromFileId('EhRprivate', false))
        .toBe('https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=EhRprivate');
    });
  });

  it('bounds retained card output across the entire message', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const payload = { app: 'budget-test', data: 'x'.repeat(3 * 1024 * 1024) };
      const body: MessageBody = {
        richText: {
          elems: [
            { lightApp: { data: lightAppBytes(payload) } } as any,
            { lightApp: { data: lightAppBytes(payload) } } as any,
            { lightApp: { data: lightAppBytes(payload) } } as any,
          ],
        },
      };

      const decoded = decodeRichBody(body, true);
      expect(decoded).toHaveLength(2);
      expect(decoded.every((element) => element.type === 'json')).toBe(true);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    expect(captured).toContainEqual(expect.objectContaining({
      scope: 'MsgPush.UnknownElement',
      message: expect.stringContaining('reason=message_output_budget_exceeded'),
    }));
  });

  it('charges malformed card inflation against the message budget', () => {
    const previousLevel = getLogLevel();
    const captured: Array<{ scope: string; message: string }> = [];
    setLogLevel('debug');
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));
    try {
      const compressed = deflateSync(Buffer.alloc(3 * 1024 * 1024, 0x78));
      const data = new Uint8Array(compressed.length + 1);
      data[0] = 1;
      data.set(compressed, 1);
      const body: MessageBody = {
        richText: {
          elems: Array.from({ length: 4 }, () => ({ lightApp: { data } } as any)),
        },
      };

      expect(decodeRichBody(body, true)).toEqual([]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }

    const exhausted = captured.filter((entry) => (
      entry.scope === 'MsgPush.UnknownElement'
      && entry.message.includes('reason=message_output_budget_exceeded')
    ));
    expect(exhausted).toHaveLength(2);
  });
});

describe('hasDecodableContent', () => {
  it('is false for a missing or empty body', () => {
    expect(hasDecodableContent(undefined)).toBe(false);
    expect(hasDecodableContent({})).toBe(false);
    expect(hasDecodableContent({ richText: { elems: [] } })).toBe(false);
  });

  it('is true for elems, ptt, notOnlineFile, or msgContent', () => {
    expect(hasDecodableContent({ richText: { elems: [{ text: { str: 'hi' } }] } })).toBe(true);
    expect(hasDecodableContent({ richText: { ptt: { fileName: 'a.amr' } } })).toBe(true);
    expect(hasDecodableContent({ richText: { notOnlineFile: { fileName: 'a.bin' } } })).toBe(true);
    expect(hasDecodableContent({ msgContent: new Uint8Array([1]) })).toBe(true);
  });

  it('is true when elems exist even if decodeRichBody would emit nothing', () => {
    const body: MessageBody = { richText: { elems: [{ commonElem: { serviceType: 999, businessType: 0 } }] } };
    expect(hasDecodableContent(body)).toBe(true);
    expect(decodeRichBody(body, false)).toEqual([]);
  });
});
