import { protobuf_decode, protobuf_encode, protobuf_getUnknownFieldMetadata } from '@snowluma/proton';
import { toHex, toHexUpper } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import type { MessageElement, MessageElementOf } from '../events';
import type {
  Elem,
  FileInfo,
  GroupFileExtra,
  IndexNode,
  InlineKeyboardExtra,
  MentionExtra,
  MsgInfo,
  NotOnlineImage,
  QFaceExtra,
  QSmallFaceExtra,
  TextElem,
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

function decodeBigFacesOnce(elems: ElemDecoded[]): Map<ElemDecoded, QFaceExtra | null> {
  const decoded = new Map<ElemDecoded, QFaceExtra | null>();
  for (const elem of elems) {
    const ce = elem.commonElem;
    if (ce?.serviceType !== 37 || !ce.pbElem) continue;
    decoded.set(elem, decodeProtobufPayload(
      'commonElem.bigFace',
      ce.pbElem,
      () => protobuf_decode<QFaceExtra>(ce.pbElem!),
    ));
  }
  return decoded;
}

const MARKDOWN_BUSINESS_TYPES: ReadonlySet<number> = new Set([1, 3, 4]);
const INLINE_KEYBOARD_SERVICE_TYPES: ReadonlySet<number> = new Set([46, 50, 51]);

function decodeMarkdownCommonElement(pbElem: Uint8Array, businessType: number): MessageElement | null {
  const md = decodeProtobufPayload(
    'commonElem.markdown',
    pbElem,
    () => protobuf_decode<MarkdownData>(pbElem),
  );
  const content = md?.content ?? '';
  // Business type 3 carries the 闪传 card. Current NT puts fileset identity
  // on extType=1 / extInfo (DecodeMdExtInfoFileTransfer); older cards only
  // have it inside the richui JSON. If the payload looks like FlashTransfer
  // but has no fileset, fail open to the sibling compatibility text.
  if (md && businessType === 3 && isFlashTransferMarkdown(md, content)) {
    return decodeFlashTransfer(md);
  }
  if (!content) return null;
  return { type: 'markdown', text: content };
}

function decodeMarkdownElementsOnce(elems: ElemDecoded[]): Map<ElemDecoded, MessageElement | null> {
  const decoded = new Map<ElemDecoded, MessageElement | null>();
  for (const elem of elems) {
    const ce = elem.commonElem;
    const businessType = ce?.businessType ?? 0;
    if (ce?.serviceType !== 45 || !MARKDOWN_BUSINESS_TYPES.has(businessType) || !ce.pbElem?.length) {
      continue;
    }
    decoded.set(elem, decodeMarkdownCommonElement(ce.pbElem, businessType));
  }
  return decoded;
}

function decodeInlineKeyboardCommonElement(pbElem: Uint8Array): MessageElement | null {
  const extra = decodeProtobufPayload(
    'commonElem.inlineKeyboard',
    pbElem,
    () => protobuf_decode<InlineKeyboardExtra>(pbElem),
  );
  const keyboard = extra?.keyboard;
  if (!keyboard) return null;

  return {
    type: 'inline_keyboard',
    botAppid: String(keyboard.botAppid ?? 0),
    rows: (keyboard.rows ?? []).map((row) => ({
      buttons: (row.buttons ?? []).map((button) => {
        const render = button.renderData;
        const action = button.action;
        const permission = action?.permission;
        return {
          id: button.id ?? '',
          label: render?.label ?? '',
          visitedLabel: render?.visitedLabel ?? '',
          style: render?.style ?? 0,
          type: action?.type ?? 0,
          clickLimit: action?.clickLimit ?? 0,
          unsupportedTips: action?.unsupportedTips ?? '',
          data: action?.data ?? '',
          atBotShowChannelList: action?.atBotShowChannelList ?? false,
          permissionType: permission?.type ?? 0,
          specifyRoleIds: permission?.specifyRoleIds ?? [],
          specifyUserIds: permission?.specifyUserIds ?? [],
          isReply: action?.reply ?? false,
          enter: action?.enter ?? false,
          anchor: action?.anchor ?? 0,
        };
      }),
    })),
  };
}

function decodeInlineKeyboardsOnce(elems: ElemDecoded[]): Map<ElemDecoded, MessageElement | null> {
  const decoded = new Map<ElemDecoded, MessageElement | null>();
  for (const elem of elems) {
    const ce = elem.commonElem;
    if (!ce || !INLINE_KEYBOARD_SERVICE_TYPES.has(ce.serviceType ?? 0)
      || ce.businessType !== 1 || !ce.pbElem?.length) {
      continue;
    }
    decoded.set(elem, decodeInlineKeyboardCommonElement(ce.pbElem));
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

const BIG_FACE_COMPAT_SUFFIX = ']请使用最新版手机QQ体验新功能';

function isValidBigFace(extra: QFaceExtra | null | undefined): extra is QFaceExtra & { qsid: number } {
  return extra?.qsid !== undefined && Number.isSafeInteger(extra.qsid) && extra.qsid >= 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isBigFaceCompatibilityText(extra: QFaceExtra, text: TextElem): boolean {
  const faceText = extra.text ?? '';
  const reserveData = text.pbReserve;
  if (!faceText.startsWith('/') || faceText.length === 1 || text.str !== faceText || !reserveData?.length) {
    return false;
  }

  const expected = protobuf_encode<TextElem>({
    str: `[${faceText.slice(1)}${BIG_FACE_COMPAT_SUFFIX}`,
  });
  return bytesEqual(reserveData, expected);
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

/** Whether this body carries any slot {@link decodeRichBody} would try:
 *  `richText.elems`, a voice (`ptt`), a c2c file (`notOnlineFile`), or
 *  serialized `msgContent`. Presence, not successful decode — a body that
 *  has elems we do not yet understand is still decodable content. */
export function hasDecodableContent(body: PushMsgBody | undefined): boolean {
  const rt = body?.richText;
  if (rt) {
    if (rt.elems && rt.elems.length > 0) return true;
    if (rt.ptt || rt.notOnlineFile) return true;
  }
  return !!(body?.msgContent && body.msgContent.length > 0);
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
  // [#146/#337] Rich cards and bot markdown arrive beside a plain compatibility
  // `text` element for older clients. That sibling has no independent wire
  // marker; QQ NT's codec structurally collapses the pair to the rich element.
  // Mirror that rule only after the rich payload decodes successfully, so a
  // malformed payload fails open and preserves its readable fallback text.
  // Structural @/reply/face elements are not plain text and always survive.
  const decodedCards = decodeCardsOnce(elems);
  const decodedBigFaces = decodeBigFacesOnce(elems);
  const decodedMarkdown = decodeMarkdownElementsOnce(elems);
  const decodedInlineKeyboards = decodeInlineKeyboardsOnce(elems);
  const hasRichContent = [...decodedCards.values()].some((cards) => (
    Boolean(cards.rich?.element || cards.light?.element)
  )) || [...decodedMarkdown.values()].some((element) => (
    element?.type === 'markdown' || element?.type === 'flash_file'
  ));
  // QQ NT serializes a service-37 big face as the CommonElem followed by a
  // compatibility TextElem. The latter repeats QFaceExtra.text in `str`, while
  // field 12 contains a nested TextElem whose `str` is
  // `[face name]请使用最新版手机QQ体验新功能`. Suppress only that proven wire
  // shape (#289); a sibling user-authored text has no such reserve and survives.
  let previousBigFace: QFaceExtra | null = null;
  // [#127] A QQ NT reply carries the replied sender as a structural auto-mention
  // (MentionExtra.type=2, uin=0) right after srcMsg, followed by a blank
  // separator text. Both are part of the reply wire shape, not user content —
  // drop them so they aren't reported as a spurious @ + empty segment. A real
  // user @ carries a non-zero MentionExtra.uin, so it's preserved.
  let sawReply = false;
  let dropNextBlankText = false;

  for (const elem of elems) {
    const resultCountBeforeElement = result.length;
    const precedingBigFace = previousBigFace;
    const decodedBigFace = decodedBigFaces.get(elem);
    previousBigFace = isValidBigFace(decodedBigFace) ? decodedBigFace : null;
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
      const suppressBigFaceCompatibilityText = precedingBigFace
        ? isBigFaceCompatibilityText(precedingBigFace, t)
        : false;

      if (!suppressBigFaceCompatibilityText) {
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
          // Drop the successfully decoded card/markdown compatibility sibling.
          if (text && hasRichContent) continue;
          if (text) result.push({ type: 'text', text });
        }
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
        // Big face. Payloads are decoded before iteration so the immediately
        // following compatibility TextElem can be classified without decoding
        // this protobuf twice.
        const extra = decodedBigFaces.get(elem);
        if (isValidBigFace(extra)) {
          result.push({ type: 'face', faceId: extra.qsid });
        }
      } else if (svcType === 45 && ce.pbElem && ce.pbElem.length > 0) {
        const markdown = decodedMarkdown.get(elem);
        if (markdown) result.push(markdown);
      } else if (INLINE_KEYBOARD_SERVICE_TYPES.has(svcType) && bizType === 1 && ce.pbElem?.length) {
        const keyboard = decodedInlineKeyboards.get(elem);
        if (keyboard) result.push(keyboard);
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

  return dropLegacyImageSiblings(result);
}

function isNtImage(element: MessageElement): boolean {
  if (element.type !== 'image') return false;
  if (element.picFormat != null || element.sha1Hex) return true;
  const url = element.imageUrl ?? '';
  return url.includes('://multimedia.nt.qq.com.cn/');
}

function isUsableImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname === 'multimedia.nt.qq.com.cn') return parsed.pathname.length > 1;
  return parsed.pathname.length > 1;
}

function sameImageFile(left: MessageElement, right: MessageElement): boolean {
  if (left.type !== 'image' || right.type !== 'image') return false;
  if (left.fileId && right.fileId && left.fileId === right.fileId) return true;
  return Boolean(left.md5Hex && right.md5Hex && left.md5Hex === right.md5Hex);
}

// [#389] NT pictures arrive as CommonElem plus a CustomFace / NotOnlineImage
// sibling for older clients. QQ shows one picture. Keep the NT image and drop
// the sibling when it names the same file, or when its URL cannot be fetched.
function dropLegacyImageSiblings(elements: MessageElement[]): MessageElement[] {
  const ntImages = elements.filter(isNtImage);
  return elements.filter((element) => {
    if (element.type !== 'image') return true;
    if (isNtImage(element)) return true;
    const url = element.imageUrl ?? '';
    if (!url || !isUsableImageUrl(url)) return false;
    return !ntImages.some((nt) => sameImageFile(nt, element));
  });
}

/**
 * Decode a 闪传 markdown commonElem (svc=45, biz=3) into `flash_file`.
 *
 * Current NT (DecodeMarkdownElement + DecodeMdExtInfoFileTransfer, #358):
 *   extType=1, extInfo.filesetId / name; click scheme also carries
 *   `mqqrouter://flash_transfer/open_fileset?fileset_id=`.
 * Older cards (#199/#200): only the richui JSON `data.fileSetId`.
 * Field names on the JSON card are searched recursively because the
 * sender builds that blob; extInfo tags are fixed.
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

function isFlashTransferMarkdown(md: MarkdownData | null | undefined, content: string): boolean {
  if (md?.extType === 1 && md.extInfo?.filesetId) return true;
  return content.includes('FlashTransfer') || content.includes('flash_transfer');
}

function parseQueryValue(text: string, key: string): string {
  const m = text.match(new RegExp(`[?&]${key}=([^&\\s"']+)`));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

function collectSchemeFields(obj: unknown): { filesetId: string; sceneType: number | undefined } {
  const schemes: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string') {
      if (value.includes('fileset_id=') || value.includes('open_fileset')) schemes.push(value);
      return;
    }
    if (typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) walk(child, depth + 1);
    }
  };
  walk(obj, 0);
  for (const scheme of schemes) {
    const filesetId = parseQueryValue(scheme, 'fileset_id');
    if (!filesetId) continue;
    const rawScene = parseQueryValue(scheme, 'scene_type');
    const n = Number(rawScene);
    return {
      filesetId,
      sceneType: rawScene && Number.isSafeInteger(n) && n >= 0 ? n : undefined,
    };
  }
  return { filesetId: '', sceneType: undefined };
}

function parseFlashTransferCard(content: string): {
  filesetId: string;
  fileName: string;
  sceneType: number | undefined;
} | null {
  const m = content.match(/[?&]json=([^)\s]+)/);
  let obj: unknown;
  let decodedJson = '';
  if (m) {
    try {
      decodedJson = decodeURIComponent(m[1]);
    } catch {
      decodedJson = m[1];
    }
    try {
      obj = JSON.parse(decodedJson);
    } catch {
      obj = undefined;
    }
  }

  const fromKeys = obj
    ? String(deepFindValue(obj, ['fileSetId', 'filesetId', 'fileset_id', 'file_set_id']) ?? '').trim()
    : '';
  const fromScheme = obj ? collectSchemeFields(obj) : { filesetId: '', sceneType: undefined };
  const fromRaw = {
    filesetId: parseQueryValue(decodedJson, 'fileset_id'),
    sceneType: Number(parseQueryValue(decodedJson, 'scene_type')),
  };
  const filesetId = fromKeys || fromScheme.filesetId || fromRaw.filesetId;
  if (!filesetId && obj && deepFindValue(obj, ['busId']) !== 'FlashTransfer' && !content.includes('flash_transfer')) {
    return null;
  }

  const title = obj ? deepFindValue(obj, ['title', 'fileName', 'name']) : undefined;
  const rawScene = obj ? deepFindValue(obj, ['sceneType', 'scene_type']) : undefined;
  let sceneType: number | undefined;
  if (rawScene != null && rawScene !== '') {
    const n = Number(rawScene);
    if (Number.isSafeInteger(n) && n >= 0) sceneType = n;
  }
  if (sceneType == null) sceneType = fromScheme.sceneType;
  if (sceneType == null && Number.isSafeInteger(fromRaw.sceneType) && fromRaw.sceneType >= 0 && parseQueryValue(decodedJson, 'scene_type')) {
    sceneType = fromRaw.sceneType;
  }

  return {
    filesetId,
    fileName: title != null ? String(title) : '',
    sceneType,
  };
}

function decodeFlashTransfer(md: MarkdownData): MessageElement | null {
  const ext = md.extType === 1 ? md.extInfo : undefined;
  const card = parseFlashTransferCard(md.content ?? '');
  const filesetId = (ext?.filesetId ?? card?.filesetId ?? '').trim();
  if (!filesetId) return null;

  let fileName = (ext?.name ?? '').trim();
  if (!fileName) fileName = (card?.fileName ?? '').trim();
  if (!fileName && md.summary) {
    fileName = md.summary.replace(/^\[QQ闪传\]\s*/, '').trim();
  }

  const thumbUrl = (ext?.thumbnail?.download?.downloadUrl ?? '').trim();
  return {
    type: 'flash_file',
    filesetId,
    fileName,
    sceneType: card?.sceneType ?? 0,
    ...(thumbUrl ? { thumbUrl } : {}),
  };
}

function extractRichtextExtras(
  rt: RichTextDecoded,
  elements: MessageElement[],
  isGroup = false
): void {
  // QQ's PTT codec selects either the NTV2 CommonElem representation or the
  // legacy RichText.ptt representation. Some C2C pushes still carry an empty
  // legacy placeholder beside a complete NTV2 record; decoding both produces a
  // second, unusable voice segment (#291).
  const hasNtv2Record = elements.some((element) => element.type === 'record');

  // Ptt (legacy voice)
  if (rt.ptt && !hasNtv2Record) {
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
