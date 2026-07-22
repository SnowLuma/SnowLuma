import { protobuf_decode, protobuf_getUnknownFieldMetadata } from '@snowluma/proton';
import { toHex, toHexUpper } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import type { MessageElement, MessageElementOf } from '../events';
import type {
  Elem,
  FileInfo,
  GroupFileExtra,
  IndexNode,
  MentionExtra,
  MsgInfo,
  NotOnlineImage,
  QFaceExtra,
  QSmallFaceExtra,
} from '@snowluma/proto-defs/element';
import type { MarkdownData } from '@snowluma/proto-defs/action';
import type { FileExtra, MessageBody, PushMsgBody as PushMsgBodyFull, RichText } from '@snowluma/proto-defs/message';
import {
  decompressData,
  makeImageUrl,
  MAX_RICH_CARD_MESSAGE_OUTPUT_BYTES,
  MAX_RICH_CARD_OUTPUT_BYTES,
} from './helpers';

type ElemDecoded = Elem;
type RichTextDecoded = RichText;
export type PushMsgBody = MessageBody;

const unknownElementLog = createLogger('MsgPush.UnknownElement');

// extraInfo/generalFlags are metadata attached to a real element, not message
// content by themselves. Every other listed key has an explicit decoder below.
// Anything outside this set is fail-open, but logged with its field name so a
// QQ wire change leaves a breadcrumb instead of becoming a silent data loss.
const DECODED_WIRE_FIELDS: ReadonlySet<string> = new Set([
  'text', 'face', 'notOnlineImage', 'transElem', 'marketFace', 'customFace',
  'richMsg', 'groupFile', 'videoFile', 'srcMsg', 'lightApp', 'commonElem',
  'extraInfo', 'generalFlags',
]);
const METADATA_WIRE_FIELDS: ReadonlySet<string> = new Set(['extraInfo', 'generalFlags']);

interface DecodedCardPayload {
  element: MessageElement | null;
  error: string | null;
  inputBytes: number;
  budgetBytes: number;
}

interface DecodedCards {
  rich?: DecodedCardPayload;
  light?: DecodedCardPayload;
}

function invalidCard(inputBytes: number, error: string, budgetBytes = 0): DecodedCardPayload {
  return { element: null, error, inputBytes, budgetBytes };
}

function decodeCardData(data: Uint8Array, remainingOutputBytes: number) {
  if (remainingOutputBytes <= 0) {
    return { ok: false as const, reason: 'message_output_budget_exceeded', budgetBytes: 0 };
  }
  const limit = Math.min(MAX_RICH_CARD_OUTPUT_BYTES, remainingOutputBytes);
  const decoded = decompressData(data, limit);
  if (!decoded.ok && decoded.reason === 'output_limit_exceeded' && limit < MAX_RICH_CARD_OUTPUT_BYTES) {
    return { ok: false as const, reason: 'message_output_budget_exceeded', budgetBytes: limit };
  }
  if (!decoded.ok) {
    return {
      ...decoded,
      budgetBytes: decoded.reason === 'output_limit_exceeded' ? limit : 0,
    };
  }
  return { ...decoded, budgetBytes: decoded.outputBytes };
}

function isXmlCardContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>');
}

function decodeRichMsgCard(
  elem: ElemDecoded,
  remainingOutputBytes: number,
): DecodedCardPayload | undefined {
  const rm = elem.richMsg;
  const data = rm?.template1;
  if (!data || data.length === 0) return undefined;
  const decoded = decodeCardData(data, remainingOutputBytes);
  if (!decoded.ok) return invalidCard(data.length, decoded.reason, decoded.budgetBytes);

  const content = decoded.text;
  const svcId = rm?.serviceId ?? 0;
  if (svcId !== 1 && !isXmlCardContent(content)) {
    return invalidCard(data.length, 'invalid_xml', decoded.budgetBytes);
  }
  if (svcId === 35) {
    const match = /\bm_resid="([^"]+)"/.exec(content);
    return {
      element: match
        ? { type: 'forward', resId: match[1] }
        : { type: 'xml', text: content, subType: svcId },
      error: null,
      inputBytes: data.length,
      budgetBytes: decoded.budgetBytes,
    };
  }

  if (svcId === 1) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return invalidCard(data.length, 'invalid_json_object', decoded.budgetBytes);
      }
    } catch {
      return invalidCard(data.length, 'invalid_json', decoded.budgetBytes);
    }
    return {
      element: { type: 'json', text: content },
      error: null,
      inputBytes: data.length,
      budgetBytes: decoded.budgetBytes,
    };
  }

  return {
    element: { type: 'xml', text: content, subType: svcId },
    error: null,
    inputBytes: data.length,
    budgetBytes: decoded.budgetBytes,
  };
}

function decodeLightAppCard(
  elem: ElemDecoded,
  remainingOutputBytes: number,
): DecodedCardPayload | undefined {
  const data = elem.lightApp?.data;
  if (!data || data.length === 0) return undefined;
  const decoded = decodeCardData(data, remainingOutputBytes);
  if (!decoded.ok) return invalidCard(data.length, decoded.reason, decoded.budgetBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.text);
  } catch {
    return invalidCard(data.length, 'invalid_json', decoded.budgetBytes);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidCard(data.length, 'invalid_json_object', decoded.budgetBytes);
  }

  const card = parsed as {
    app?: unknown;
    meta?: { detail?: { resid?: unknown; uniseq?: unknown } };
  };
  if (card.app === 'com.tencent.multimsg') {
    const detail = card.meta?.detail ?? {};
    const resId = typeof detail.resid === 'string' ? detail.resid : '';
    const uniseq = typeof detail.uniseq === 'string' ? detail.uniseq : '';
    if (resId) {
      return {
        element: { type: 'forward', resId, forwardUuid: uniseq || undefined },
        error: null,
        inputBytes: data.length,
        budgetBytes: decoded.budgetBytes,
      };
    }
  }

  return {
    element: { type: 'json', text: decoded.text },
    error: null,
    inputBytes: data.length,
    budgetBytes: decoded.budgetBytes,
  };
}

function decodeCardsOnce(elems: ElemDecoded[]): Map<ElemDecoded, DecodedCards> {
  const decoded = new Map<ElemDecoded, DecodedCards>();
  let remainingOutputBytes = MAX_RICH_CARD_MESSAGE_OUTPUT_BYTES;
  for (const elem of elems) {
    const cards: DecodedCards = {};
    const rich = decodeRichMsgCard(elem, remainingOutputBytes);
    if (rich) remainingOutputBytes = Math.max(0, remainingOutputBytes - rich.budgetBytes);
    const light = decodeLightAppCard(elem, remainingOutputBytes);
    if (light) remainingOutputBytes = Math.max(0, remainingOutputBytes - light.budgetBytes);
    if (rich) cards.rich = rich;
    if (light) cards.light = light;
    if (!rich && !light) continue;
    decoded.set(elem, cards);
    for (const [source, card] of Object.entries(cards)) {
      if (card?.error) {
        unknownElementLog.debug(
          'wire %s card ignored inputBytes=%d reason=%s',
          source,
          card.inputBytes,
          card.error,
        );
      }
    }
  }
  return decoded;
}

function logUnknownWireMetadata(
  value: unknown,
  path: string,
  depth = 0,
  seen = new WeakSet<object>(),
): void {
  if (depth > 16 || value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
  if (seen.has(value)) return;
  seen.add(value);

  logUnknownWireFields(value, path);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => logUnknownWireMetadata(entry, `${path}[${index}]`, depth + 1, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    logUnknownWireMetadata(entry, `${path}.${key}`, depth + 1, seen);
  }
}

function logUnknownWireFields(value: unknown, path: string): void {
  const metadata = protobuf_getUnknownFieldMetadata(value);
  for (const unknown of metadata.fields) {
    unknownElementLog.debug(
      'wire element ignored unknownTag=%d wireType=%d count=%d bytes=%d reason=no schema decoder path=%s',
      unknown.fieldNumber,
      unknown.wireType,
      unknown.count,
      unknown.totalByteLength,
      path,
    );
  }
  if (metadata.omittedOccurrences > 0) {
    unknownElementLog.debug(
      'wire unknown metadata truncated totalOccurrences=%d retainedKinds=%d omittedOccurrences=%d omittedBytes=%d path=%s',
      metadata.totalOccurrences,
      metadata.fields.length,
      metadata.omittedOccurrences,
      metadata.omittedByteLength,
      path,
    );
  }
}

function classifyProtobufDecodeError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('truncated')) return 'protobuf_truncated';
  if (message.includes('overflow')) return 'protobuf_varint_overflow';
  if (message.includes('bounds') || message.includes('invalid progress')) return 'protobuf_bounds';
  if (message.includes('wire type')) return 'protobuf_invalid_wire_type';
  if (message.includes('field number')) return 'protobuf_invalid_field_number';
  if (message.includes('group')) return 'protobuf_invalid_group';
  return 'protobuf_decode_failed';
}

function decodeProtobufPayload<T>(
  source: string,
  data: Uint8Array,
  decode: () => T,
): T | null {
  try {
    const decoded = decode();
    logUnknownWireMetadata(decoded, source);
    return decoded;
  } catch (error) {
    unknownElementLog.debug(
      'wire protobuf payload ignored source=%s bytes=%d reason=%s',
      source,
      data.length,
      classifyProtobufDecodeError(error),
    );
    return null;
  }
}

type FingerprintElement =
  | MessageElementOf<'image'>
  | MessageElementOf<'record'>
  | MessageElementOf<'video'>
  | MessageElementOf<'file'>;

function assignValidFingerprints(
  element: FingerprintElement,
  md5Hex: string | undefined,
  sha1Hex: string | undefined,
  source: string,
): void {
  if (md5Hex) {
    if (/^[0-9a-fA-F]{32}$/.test(md5Hex)) element.md5Hex = md5Hex;
    else unknownElementLog.debug('wire %s ignored invalid md5 fingerprint length=%d', source, md5Hex.length);
  }
  if (sha1Hex) {
    if (/^[0-9a-fA-F]{40}$/.test(sha1Hex)) element.sha1Hex = sha1Hex;
    else unknownElementLog.debug('wire %s ignored invalid sha1 fingerprint length=%d', source, sha1Hex.length);
  }
}

/**
 * Build the `mediaNode` re-upload descriptor from an NTV2 IndexNode + FileInfo.
 * Record and video decode to the byte-identical `{ fileUuid, storeId,
 * uploadTime, ttl, subType, info:{…} }` shape — share one builder so the two
 * never drift (add a field to one and forget the other).
 */
function buildMediaNode(idx: IndexNode, fi: FileInfo): MessageElement['mediaNode'] {
  return {
    fileUuid: idx.fileUuid,
    storeId: idx.storeId,
    uploadTime: idx.uploadTime,
    ttl: idx.ttl,
    subType: idx.subType,
    info: {
      fileSize: fi.fileSize,
      fileHash: fi.fileHash,
      fileSha1: fi.fileSha1,
      fileName: fi.fileName,
      width: fi.width,
      height: fi.height,
      time: fi.time,
      original: fi.original,
      type: {
        type: fi.type?.type,
        picFormat: fi.type?.picFormat,
        videoFormat: fi.type?.videoFormat,
        voiceFormat: fi.type?.voiceFormat,
      },
    },
  };
}

export function decodeRichBody(body: PushMsgBody | undefined, isGroup: boolean): MessageElement[] {
  const elements: MessageElement[] = [];
  logUnknownWireFields(body, 'body');
  if (body?.richText) {
    const rt = body.richText;
    logUnknownWireFields(rt, 'body.richText');
    if (rt.elems) elements.push(...convertElements(rt.elems as ElemDecoded[]));
    extractRichtextExtras(rt, elements, isGroup);
  }
  if (body?.msgContent && body.msgContent.length > 0) {
    extractMsgContent(body.msgContent, elements);
  }
  return elements;
}

function convertElements(elems: ElemDecoded[]): MessageElement[] {
  const result: MessageElement[] = [];
  // [#146] A QQ mini-program / ark share (B站 video, QQ 小程序, …) arrives as a
  // `lightApp`/`richMsg` card element plus a plain `text` element carrying QQ's
  // graceful-degradation compat string ("当前QQ版本不支持此应用，请升级") — the text
  // protocol-old clients render instead of the card. The text element has NO wire
  // marker distinguishing it (confirmed on-target: no pbReserve / attr6Buf), and
  // the receiver binary contains none of these strings, so QQ does NOT match by
  // content. Instead QQ NT's kernel codec (msg_codec_mgr) collapses the message
  // to a single ark element — the sibling text is never emitted (verified by RE:
  // wrapper.linux.node has no fallback strings; NapCat maps kernel elements 1:1
  // with no ark-aware skip yet surfaces only the card). We mirror that structural
  // rule: when a card is present, drop sibling plain `text`. `@`/reply/face etc.
  // are not plain text and survive. `richMsg` covers json (svc=1) and xml (svc=35)
  // cards alike.
  // Only a card that can actually decode is allowed to suppress QQ's sibling
  // compatibility text. Field presence alone is insufficient: a malformed
  // card must fail open and preserve its otherwise-valid text sibling.
  const decodedCards = decodeCardsOnce(elems);
  const hasCard = [...decodedCards.values()].some((cards) => (
    Boolean(cards.rich?.element || cards.light?.element)
  ));
  // [#127] A QQ NT reply carries the replied sender as a structural auto-mention
  // (MentionExtra.type=2, uin=0) right after srcMsg, followed by a blank
  // separator text. Both are part of the reply wire shape, not user content —
  // drop them so they aren't reported as a spurious @ + empty segment. A real
  // user @ carries a non-zero MentionExtra.uin, so it's preserved.
  let sawReply = false;
  let dropNextBlankText = false;

  for (const elem of elems) {
    const resultCountBeforeElement = result.length;
    logUnknownWireMetadata(elem, 'elem');

    // Proton materializes every schema key with a null/default value, so key
    // presence alone is not evidence that the wire carried that element.
    // Report only unsupported fields with an actual decoded value.
    const unsupportedFields = Object.entries(elem)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key]) => key)
      .filter((key) => !DECODED_WIRE_FIELDS.has(key));
    if (unsupportedFields.length > 0) {
      unknownElementLog.debug(
        'wire element ignored fields=%s reason=no MessageElement decoder',
        unsupportedFields.join(','),
      );
    }

    // Reply / quote. `origSeqs[0]` is the shared group sequence for groups and
    // the quoted sender's local client sequence for C2C. The latter is not the
    // conversation-wide NT sequence used by private history/message ids, so the
    // OneBot layer resolves it with peer + sender direction + quote time.
    if (elem.srcMsg) {
      // On-target capture (#114 / #124) also proved reserve.friendSequence is a
      // small friend-relationship counter, not either usable message sequence.
      const src = elem.srcMsg;
      const replySeq = src.origSeqs?.[0] ?? 0;
      if (replySeq > 0) {
        const reply: MessageElement = { type: 'reply', replySeq };
        if (src.senderUin) reply.replySenderUin = Number(src.senderUin);
        if (src.time) reply.replyTime = src.time;
        // Decode the quoted message's own elements (SrcMsg.elems, field 5) so a
        // backfill can reconstruct it locally if it isn't in the store / server.
        if (src.elemsRaw?.length) {
          const decoded: ElemDecoded[] = [];
          for (const [index, raw] of src.elemsRaw.entries()) {
            const nested = decodeProtobufPayload(
              `srcMsg.elemsRaw[${index}]`,
              raw,
              () => protobuf_decode<Elem>(raw),
            );
            if (nested) decoded.push(nested);
          }
          if (decoded.length) reply.replyElements = convertElements(decoded);
        }
        // A C2C quoted FILE lives in RichText.notOnlineFile (message level), not
        // in elems[] — recover it from sourceMsg (field 9) when elems carried no
        // file, so a quoted file's content survives into get_msg (#124).
        if (src.sourceMsg?.length && !reply.replyElements?.some((e) => e.type === 'file')) {
          const pmsg = decodeProtobufPayload(
            'srcMsg.sourceMsg',
            src.sourceMsg,
            () => protobuf_decode<PushMsgBodyFull>(src.sourceMsg!),
          );
          const nof = pmsg?.body?.richText?.notOnlineFile;
          if (nof?.fileName) {
            (reply.replyElements ??= []).push({
              type: 'file',
              fileName: nof.fileName,
              fileSize: nof.fileSize !== undefined ? Number(nof.fileSize) : 0,
              fileId: nof.fileUuid ?? '',
            });
          }
        }
        result.push(reply);
      }
      sawReply = true;
    }

    // Text (with possible @ detection)
    if (elem.text) {
      const t = elem.text;
      let mention: MentionExtra | null = null;
      if (t.pbReserve && t.pbReserve.length > 0) {
        mention = decodeProtobufPayload(
          'text.pbReserve',
          t.pbReserve,
          () => protobuf_decode<MentionExtra>(t.pbReserve!),
        );
      }
      const hasAttr6 = t.attr6Buf && t.attr6Buf.length > 11;
      const hasMention = mention && (mention.type === 1 || mention.type === 2);

      // [#127] drop the reply's structural auto-mention (type=2, uin=0) and the
      // blank separator text right after it; keep real @s (non-zero uin).
      if (sawReply && mention && mention.type === 2 && (mention.uin ?? 0) === 0) {
        dropNextBlankText = true;
        continue;
      }
      if (dropNextBlankText) {
        dropNextBlankText = false;
        if (!hasMention && (t.str ?? '').trim() === '') continue;
      }

      if (hasAttr6 || hasMention) {
        const me: MessageElement = { type: 'at', targetUin: 0, text: t.str ?? '' };
        if (hasAttr6) {
          const buf = t.attr6Buf!;
          me.targetUin = ((buf[7] << 24) | (buf[8] << 16) | (buf[9] << 8) | buf[10]) >>> 0;
        }
        if (hasMention && mention) {
          me.uid = mention.uid ?? '';
          if (!me.targetUin) me.targetUin = mention.uin ?? 0;
        }
        result.push(me);
      } else {
        const text = t.str ?? '';
        // [#146] drop QQ's ark-compat fallback text — structurally, like the
        // kernel codec: a card message collapses to just the card element.
        if (text && hasCard) continue;
        if (text) result.push({ type: 'text', text });
      }
    }

    // Face
    if (elem.face) {
      const faceId = elem.face.index ?? 0;
      if (Number.isSafeInteger(faceId) && faceId >= 0) result.push({ type: 'face', faceId });
    }

    // MarketFace (商城表情). Keep the wire identity (`emojiId`/`tabId`/`key`)
    // on the element; the OneBot layer unifies it to an `image` segment with
    // these as markers (NapCat-compatible), and the send path rebuilds the
    // wire `marketFace` from them. `emojiId` is the lowercase hex of the
    // `faceId` GUID bytes — it also forms the gxh gif URL on the segment side.
    if (elem.marketFace) {
      const mf = elem.marketFace;
      if (mf.faceId?.length === 16) {
        result.push({
          type: 'mface',
          text: mf.faceName ?? '',
          emojiId: toHex(mf.faceId),
          emojiPackageId: mf.tabId ?? 0,
          emojiKey: mf.key ?? '',
        });
      }
    }

    // NotOnlineImage (C2C image)
    if (elem.notOnlineImage) {
      const img = elem.notOnlineImage;
      if (img.picMd5?.length === 16) {
        const urlPath = img.origUrl || img.bigUrl || '';
        result.push({
          type: 'image',
          imageUrl: makeImageUrl(urlPath),
          fileId: img.filePath ?? '',
          fileSize: img.fileLen ?? 0,
          width: img.picWidth ?? 0,
          height: img.picHeight ?? 0,
          subType: img.pbRes?.subType ?? 0,
          // `[图片]` / `[动画表情]` are the QQ-ecosystem default
          // bubble texts; mobile QQ + Lagrange.Core + NapCat all
          // expect these literal Chinese strings when the wire
          // doesn't carry a per-image override.
          summary: img.pbRes?.summary || (img.pbRes?.subType === 1 ? '[动画表情]' : '[图片]'),
          md5Hex: toHexUpper(img.picMd5),
        });
      }
    }

    // CustomFace (group image)
    if (elem.customFace) {
      const img = elem.customFace;
      if (img.md5?.length === 16) {
        result.push({
          type: 'image',
          imageUrl: makeImageUrl(img.origUrl ?? ''),
          fileId: img.filePath ?? '',
          fileSize: img.size ?? 0,
          width: img.width ?? 0,
          height: img.height ?? 0,
          subType: img.pbRes?.subType ?? 0,
          summary: img.pbRes?.summary || (img.pbRes?.subType === 1 ? '[动画表情]' : '[图片]'),
          md5Hex: toHexUpper(img.md5),
        });
      }
    }

    // VideoFile
    if (elem.videoFile) {
      const v = elem.videoFile;
      result.push({
        type: 'video',
        fileId: v.fileUuid ?? '',
        fileName: v.fileName ?? '',
        fileSize: v.fileSize ?? 0,
        duration: v.fileTime ?? 0,
        fileHash: v.fileMd5 && v.fileMd5.length > 0 ? toHexUpper(v.fileMd5) : '',
        mediaNode: {
          fileUuid: v.fileUuid ?? '',
          info: {
            fileSize: v.fileSize ?? 0,
            fileHash: v.fileMd5 && v.fileMd5.length > 0 ? toHexUpper(v.fileMd5) : '',
            fileName: v.fileName ?? '',
            width: v.fileWidth ?? 0,
            height: v.fileHeight ?? 0,
            time: v.fileTime ?? 0,
            type: {
              type: 2,
              videoFormat: v.fileFormat ?? 0,
            },
          },
        },
      });
    }

    // GroupFile
    if (elem.groupFile) {
      const f = elem.groupFile;
      result.push({
        type: 'file',
        fileId: f.fileId ?? '',
        fileName: f.filename ?? '',
        fileSize: f.fileSize !== undefined ? Number(f.fileSize) : 0,
      });
    }

    // TransElem type=24 (group file via transport)
    if (elem.transElem) {
      const te = elem.transElem;
      const resultCountBeforeTrans = result.length;
      if ((te.elemType ?? 0) === 24 && te.elemValue && te.elemValue.length > 3) {
        const val = te.elemValue;
        const len = (val[1] << 8) | val[2];
        if (val.length >= 3 + len) {
          const payload = val.subarray(3, 3 + len);
          const extra = decodeProtobufPayload(
            'transElem.groupFile',
            payload,
            () => protobuf_decode<GroupFileExtra>(payload),
          );
          if (extra?.inner?.info) {
            const info = extra.inner.info;
            result.push({
              type: 'file',
              fileName: info.fileName ?? '',
              fileSize: info.fileSize !== undefined ? Number(info.fileSize) : 0,
              fileId: info.fileId ?? '',
            });
          }
        }
      }
      if (result.length === resultCountBeforeTrans) {
        unknownElementLog.debug(
          'wire transElem ignored elemType=%d reason=no recognized MessageElement payload',
          te.elemType ?? 0,
        );
      }
    }

    // RichMsg
    const cards = decodedCards.get(elem);
    if (cards?.rich?.element) result.push(cards.rich.element);

    // LightApp
    if (cards?.light?.element) result.push(cards.light.element);

    // CommonElem
    if (elem.commonElem) {
      const ce = elem.commonElem;
      const svcType = ce.serviceType ?? 0;
      const bizType = ce.businessType ?? 0;
      const resultCountBeforeCommon = result.length;

      if (svcType === 2) {
        // Poke
        result.push({ type: 'poke', subType: bizType });
      } else if (svcType === 3 && ce.pbElem && ce.pbElem.length > 1) {
        // Flash image
        const pb = ce.pbElem;
        let pos = 1;
        let length = 0, shift = 0;
        while (pos < pb.length) {
          const b = pb[pos++];
          length |= (b & 0x7f) << shift;
          shift += 7;
          if ((b & 0x80) === 0) break;
        }
        if (pos + length <= pb.length) {
          const payload = pb.subarray(pos, pos + length);
          const img = decodeProtobufPayload(
            'commonElem.flashImage',
            payload,
            () => protobuf_decode<NotOnlineImage>(payload),
          );
          if (img) {
            const me: MessageElement = {
              type: 'image', fileId: img.filePath ?? '',
              fileSize: img.fileLen ?? 0, width: img.picWidth ?? 0,
              height: img.picHeight ?? 0, flash: true, summary: '[flash image]',
            };
            if (img.pbRes) me.subType = img.pbRes.subType ?? 0;
            if (img.picMd5 && img.picMd5.length > 0) {
              me.imageUrl = 'http://gchat.qpic.cn/gchatpic_new/0/0-0-' + toHexUpper(img.picMd5) + '/0';
            }
            result.push(me);
          }
        }
      } else if (ce.pbElem && (svcType === 48 || bizType === 10 || bizType === 20 || bizType === 11 || bizType === 21 || bizType === 12 || bizType === 22)) {
        // NTQQ new protocol image/record/video
        const info = decodeProtobufPayload(
          'commonElem.msgInfo',
          ce.pbElem,
          () => protobuf_decode<MsgInfo>(ce.pbElem!),
        );
        if (info?.msgInfoBody && info.msgInfoBody.length > 0) {
          const body = info.msgInfoBody[0];
          if (body.index?.info) {
            const idx = body.index;
            const fi = idx.info!;

            if (bizType === 10 || bizType === 20) {
              // Image
              let url = '';
              if (body.picture) {
                const domain = body.picture.domain ?? 'multimedia.nt.qq.com.cn';
                const path = body.picture.urlPath ?? '';
                if (path) {
                  url = 'https://' + domain + path;
                  if (body.picture.ext?.originalParameter) {
                    url += body.picture.ext.originalParameter;
                  }
                }
              }
              const me: MessageElement = {
                type: 'image', fileId: fi.fileName ?? '',
                fileSize: fi.fileSize ?? 0, width: fi.width ?? 0,
                height: fi.height ?? 0, imageUrl: url,
              };
              assignValidFingerprints(me, fi.fileHash, fi.fileSha1, 'commonElem image');
              if (fi.type?.picFormat) me.picFormat = fi.type.picFormat;
              if (info.extBizInfo?.pic) {
                me.subType = info.extBizInfo.pic.bizType ?? 0;
                me.summary = info.extBizInfo.pic.textSummary
                  || (me.subType === 1 ? '[动画表情]' : '[图片]');
              }
              result.push(me);
            } else if (bizType === 12 || bizType === 22) {
              // Record
              const record: MessageElementOf<'record'> = {
                type: 'record', fileName: fi.fileName ?? '',
                fileId: idx.fileUuid ?? '', duration: fi.time ?? 0,
                fileHash: fi.fileHash ?? '',
                fileSize: fi.fileSize ?? 0,
                voiceFormat: fi.type?.voiceFormat ?? 0,
                mediaNode: buildMediaNode(idx, fi),
              };
              assignValidFingerprints(record, fi.fileHash, fi.fileSha1, 'commonElem record');
              result.push(record);
            } else if (bizType === 11 || bizType === 21) {
              // Video
              const video: MessageElementOf<'video'> = {
                type: 'video', fileName: fi.fileName ?? '',
                fileId: idx.fileUuid ?? '', fileSize: fi.fileSize ?? 0,
                duration: fi.time ?? 0,
                fileHash: fi.fileHash ?? '',
                width: fi.width ?? 0,
                height: fi.height ?? 0,
                videoFormat: fi.type?.videoFormat ?? 0,
                mediaNode: buildMediaNode(idx, fi),
              };
              assignValidFingerprints(video, fi.fileHash, fi.fileSha1, 'commonElem video');
              result.push(video);
            }
          }
        }
      } else if (svcType === 33 && ce.pbElem) {
        // Small face
        const extra = decodeProtobufPayload(
          'commonElem.smallFace',
          ce.pbElem,
          () => protobuf_decode<QSmallFaceExtra>(ce.pbElem!),
        );
        const faceId = extra?.faceId ?? 0;
        if (Number.isSafeInteger(faceId) && faceId >= 0) result.push({ type: 'face', faceId });
      } else if (svcType === 37 && ce.pbElem) {
        // Big face
        const extra = decodeProtobufPayload(
          'commonElem.bigFace',
          ce.pbElem,
          () => protobuf_decode<QFaceExtra>(ce.pbElem!),
        );
        if (extra?.qsid !== undefined && Number.isSafeInteger(extra.qsid) && extra.qsid >= 0) {
          result.push({ type: 'face', faceId: extra.qsid });
        }
      } else if (svcType === 45 && ce.pbElem && ce.pbElem.length > 0) {
        // Markdown commonElem. Older QQ clients (≤9.9.30) deliver a 闪传 (flash
        // transfer) file as a richui markdown card (busId=FlashTransfer); newer
        // clients send a plain text+link message that decodes elsewhere. Pull
        // the flash fields out so the message isn't dropped to empty (#199/#200).
        const flash = decodeFlashTransferCard(ce.pbElem);
        if (flash) result.push(flash);
      }

      // Route predicates alone are not proof that a payload decoded. Log any
      // CommonElem that produced no MessageElement, including known service
      // types with a new businessType or a malformed/unrecognized payload.
      if (result.length === resultCountBeforeCommon) {
        unknownElementLog.debug(
          'wire commonElem ignored serviceType=%d businessType=%d reason=no recognized MessageElement payload',
          svcType,
          bizType,
        );
      }
    }

    // Known content fields can also drift or arrive malformed. Preserve the
    // rest of the message, but make every standalone decode miss observable.
    // transElem/CommonElem emit richer diagnostics in their own branches.
    if (result.length === resultCountBeforeElement) {
      const ignoredKnownFields = Object.entries(elem)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key]) => key)
        .filter((key) => (
          DECODED_WIRE_FIELDS.has(key)
          && !METADATA_WIRE_FIELDS.has(key)
          && key !== 'transElem'
          && key !== 'commonElem'
        ));
      if (ignoredKnownFields.length > 0) {
        unknownElementLog.debug(
          'wire element ignored fields=%s reason=no recognized MessageElement payload',
          ignoredKnownFields.join(','),
        );
      }
    }
  }

  return result;
}

/**
 * Decode a 闪传 richui markdown commonElem (svc=45) into a `flash_file`
 * element. The pbElem is a `MarkdownData` whose `content` is a markdown link
 * `[闪传](mqqapi://markdown/node?nodeType=richui&json=<url-encoded JSON>)`; the
 * JSON's `busId` is `FlashTransfer`. Field NAMES (fileSetId / sceneType /
 * title) were confirmed against QQ NT's flash-transfer manager in
 * wrapper.node.i64; the exact nesting is unknown (the card is built by the
 * sender's client), so we search recursively rather than pin a path. Returns
 * null for any non-flash markdown. See #199 / #200.
 */
function deepFindValue(obj: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 8 || obj === null || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const key of keys) {
    const v = rec[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  for (const v of Object.values(rec)) {
    const found = deepFindValue(v, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function decodeFlashTransferCard(pbElem: Uint8Array): MessageElement | null {
  const md = decodeProtobufPayload(
    'commonElem.flashTransfer',
    pbElem,
    () => protobuf_decode<MarkdownData>(pbElem),
  );
  const content = md?.content ?? '';
  if (!content.includes('FlashTransfer')) return null;
  const m = content.match(/[?&]json=([^)\s]+)/);
  if (!m) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
  if (deepFindValue(obj, ['busId']) !== 'FlashTransfer') return null;
  const filesetId = deepFindValue(obj, ['fileSetId', 'filesetId', 'fileset_id', 'file_set_id']);
  const title = deepFindValue(obj, ['title', 'fileName', 'name']);
  const sceneType = deepFindValue(obj, ['sceneType', 'scene_type']);
  const normalizedFilesetId = filesetId != null ? String(filesetId).trim() : '';
  if (!normalizedFilesetId) return null;
  const normalizedSceneType = sceneType == null ? 0 : Number(sceneType);
  if (!Number.isSafeInteger(normalizedSceneType) || normalizedSceneType < 0) return null;
  return {
    type: 'flash_file',
    filesetId: normalizedFilesetId,
    fileName: title != null ? String(title) : '',
    sceneType: normalizedSceneType,
  };
}

function extractRichtextExtras(
  rt: RichTextDecoded,
  elements: MessageElement[],
  isGroup = false
): void {
  // Ptt (voice)
  if (rt.ptt) {
    const p = rt.ptt;
    const md5Hex = p.fileMd5 && p.fileMd5.length > 0 ? toHexUpper(p.fileMd5) : undefined;
    const me: MessageElementOf<'record'> = {
      type: 'record', fileName: p.fileName ?? '',
      fileSize: p.fileSize ?? 0, duration: p.time ?? 0,
      fileHash: md5Hex ?? '',
      voiceFormat: p.format ?? 0,
    };
    assignValidFingerprints(me, md5Hex, undefined, 'ptt');
    if (isGroup && (p.fileId ?? 0n) !== 0n) {
      me.fileId = p.groupFileKey ?? '';
    } else {
      if (p.fileUuid && p.fileUuid.length > 0) {
        me.fileId = Buffer.from(p.fileUuid).toString('utf8');
      }
    }
    me.mediaNode = {
      fileUuid: me.fileId ?? '',
      info: {
        fileSize: p.fileSize ?? 0,
        fileHash: p.fileMd5 && p.fileMd5.length > 0 ? toHexUpper(p.fileMd5) : '',
        fileName: p.fileName ?? '',
        time: p.time ?? 0,
        type: {
          type: 3,
          voiceFormat: p.format ?? 0,
        },
      },
    };
    elements.push(me);
  }

  // NotOnlineFile (C2C file)
  if (rt.notOnlineFile) {
    const f = rt.notOnlineFile;
    elements.push({
      type: 'file', fileId: f.fileUuid ?? '',
      fileName: f.fileName ?? '',
      fileSize: f.fileSize !== undefined ? Number(f.fileSize) : 0,
      fileHash: f.fileHash ?? '',
    });
  }
}

function extractMsgContent(msgContent: Uint8Array, elements: MessageElement[]): void {
  // `MessageBody.msgContent` is where the QQ-NT server actually puts
  // c2c file metadata — serialised `FileExtra { file: NotOnlineFile }`
  // bytes. The previous schema (`FileExtraInfoSchema` with fileSize=1/
  // fileName=2/fileMd5=3/fileUuid=4/fileHash=5) didn't match the wire
  // shape — every field landed at the wrong tag, so the four-field
  // truthiness check below filtered out every real c2c file push as
  // "incomplete metadata". After consolidating FileExtra to wrap
  // `NotOnlineFile` (Lagrange.Core's `FileExtra { File: NotOnlineFile }`),
  // this reads the right tags.
  const extra = decodeProtobufPayload(
    'messageBody.msgContent',
    msgContent,
    () => protobuf_decode<FileExtra>(msgContent),
  );
  if (!extra?.file) return;
  const f = extra.file;
  if (!f.fileUuid) return;
  elements.push({
    type: 'file',
    fileId: f.fileUuid,
    fileName: f.fileName ?? '',
    fileSize: f.fileSize !== undefined ? Number(f.fileSize) : 0,
    fileHash: f.fileHash ?? '',
  });
}
