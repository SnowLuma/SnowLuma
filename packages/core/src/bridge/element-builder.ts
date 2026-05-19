// Element Builder — converts internal MessageElement[] into proto Elem objects
// for encoding with protoEncode(SendMessageRequestSchema).
// Port of src/bridge/src/bridge_messages.cpp build_send_elems()

import type { Bridge } from './bridge';
import type { MessageElement } from './events';
import type { ProtoDecoded } from '../protobuf/decode';
import { protobuf_encode } from '@snowluma/proton';
import {
  ElemSchema,
} from './proto/element';
import type {
  MentionExtraSend,
  MarkdownData,
} from './proto/proton/action';
import type { GroupFileExtra } from './proto/proton/element';
import { uploadImageMsgInfo } from './highway/image-upload';
import { uploadPttMsgInfo } from './highway/ptt-upload';
import { uploadVideoMsgInfo } from './highway/video-upload';
import { hexToBytes } from './highway/pipeline';

type ProtoElem = Partial<ProtoDecoded<typeof ElemSchema>>;

export interface SendContext {
  bridge: Bridge;
  groupId?: number;
  userUid?: string;
}

function makeTextElem(text: string): ProtoElem {
  return {
    text: { str: text } as any,
  };
}

function makeFaceElem(faceId: number): ProtoElem {
  return {
    face: { index: faceId } as any,
  };
}

function resolveMentionDisplay(ctx: SendContext | undefined, targetUin: number): string {
  if (!ctx || !targetUin) return '';
  if (ctx.groupId !== undefined) {
    const member = ctx.bridge.identity.findGroupMember(ctx.groupId, targetUin);
    return member?.card?.trim() || member?.nickname?.trim() || '';
  }
  const friend = ctx.bridge.identity.findFriend(targetUin);
  return friend?.remark?.trim() || friend?.nickname?.trim() || '';
}

function makeMentionElem(element: MessageElement, ctx?: SendContext): ProtoElem {
  const mentionAll = element.uid === 'all' || element.targetUin === 0;
  const targetUin = element.targetUin ?? 0;

  const extra = protobuf_encode<MentionExtraSend>({
    type: mentionAll ? 1 : 2,
    uin: mentionAll ? 0 : targetUin,
    field5: 0,
    uid: mentionAll ? 'all' : (element.uid ?? ''),
  });

  // Prefer an explicit display string from the caller; otherwise look the
  // target up in the roster so QQ renders `@昵称` instead of `@QQ号`.
  // Falls back to the bare uin when the roster doesn't know them yet.
  let str = element.text;
  if (!str) {
    if (mentionAll) {
      str = '@全体成员 ';
    } else {
      const name = resolveMentionDisplay(ctx, targetUin);
      str = name ? `@${name} ` : `@${targetUin} `;
    }
  }

  return {
    text: {
      str,
      pbReserve: extra,
    } as any,
  };
}

function makeReplyElem(element: MessageElement): ProtoElem {
  const seq = element.replySeq! & 0xFFFFFFFF;
  
  const srcMsg: any = {
    origSeqs: [seq],
  };
  
  // Add additional fields if available for better reply display
  if (element.replySenderUin) {
    srcMsg.senderUin = BigInt(element.replySenderUin);
  }
  if (element.replyTime) {
    srcMsg.time = element.replyTime;
  }
  
  return { srcMsg };
}

function makeJsonElem(element: MessageElement): ProtoElem {
  const content = element.text ?? '';
  const payload = new Uint8Array(content.length + 1);
  payload[0] = 0x00;
  const encoded = new TextEncoder().encode(content);
  payload.set(encoded, 1);

  return {
    richMsg: {
      serviceId: 1,
      template1: payload,
    } as any,
  };
}

function makeXmlElem(element: MessageElement): ProtoElem {
  const content = element.text ?? '';
  const payload = new Uint8Array(content.length + 1);
  payload[0] = 0x00;
  const encoded = new TextEncoder().encode(content);
  payload.set(encoded, 1);

  return {
    richMsg: {
      serviceId: element.subType === 0 ? 35 : (element.subType ?? 35),
      template1: payload,
    } as any,
  };
}

function makeMarkdownElem(element: MessageElement): ProtoElem {
  const data = protobuf_encode<MarkdownData>({ content: element.text ?? '' });

  return {
    commonElem: {
      serviceType: 45,
      pbElem: data,
      businessType: 1,
    } as any,
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function makeForwardElem(element: MessageElement): ProtoElem {
  const resId = (element.resId ?? '').trim();
  if (!resId) {
    throw new Error('forward resId is required');
  }

  // Multi-msg preview bubble — modelled on the go-cqhttp / NapCat XML.
  // `source` becomes the bold header (e.g. "群聊的聊天记录"), `news`
  // entries become per-line previews ("nick: text"), `summary` is the
  // grey footer ("查看 N 条转发消息"), `prompt` is the chat-list brief.
  const source = element.forwardSource && element.forwardSource.length > 0
    ? element.forwardSource
    : '聊天记录';
  const summary = element.forwardSummary && element.forwardSummary.length > 0
    ? element.forwardSummary
    : '查看转发消息';
  const prompt = element.forwardPrompt && element.forwardPrompt.length > 0
    ? element.forwardPrompt
    : '[聊天记录]';
  const news = Array.isArray(element.forwardNews) ? element.forwardNews : [];
  const tSum = element.forwardTSum && element.forwardTSum > 0
    ? element.forwardTSum
    : Math.max(news.length, 1);

  const newsTitles = news
    .map(n => `<title size="26" color="#777777">${escapeXml(n.text ?? '')}</title>`)
    .join('');

  const resIdAttr = escapeXml(resId);
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<msg templateID="1" action="viewMultiMsg" serviceID="35"` +
    ` brief="${escapeXml(prompt)}"` +
    ` m_resid="${resIdAttr}" m_fileName="${resIdAttr}" actionData="${resIdAttr}"` +
    ` tSum="${tSum}" sourceMsgId="0" flag="3" adverSign="0" multiMsgFlag="0">` +
    `<item layout="1">` +
    `<title size="34" color="#000000">${escapeXml(source)}</title>` +
    newsTitles +
    `<hr hidden="false" style="0"/>` +
    `<summary size="26" color="#808080">${escapeXml(summary)}</summary>` +
    `</item>` +
    `<source name="${escapeXml(source)}" icon="" action="" appid="-1"/>` +
    `</msg>`;

  const encodedXml = new TextEncoder().encode(xml);
  const payload = new Uint8Array(encodedXml.length + 1);
  payload[0] = 0x00;
  payload.set(encodedXml, 1);

  return {
    richMsg: {
      serviceId: 35,
      template1: payload,
    } as any,
  };
}

async function makeImageElem(ctx: SendContext, element: MessageElement): Promise<ProtoElem> {
  const isGroup = ctx.groupId !== undefined;
  const targetIdOrUid = isGroup ? ctx.groupId! : (ctx.userUid ?? '');
  if (!isGroup && !targetIdOrUid) {
    throw new Error('private image target uid is missing');
  }

  const msgInfo = await uploadImageMsgInfo(ctx.bridge, isGroup, targetIdOrUid, element);

  return {
    commonElem: {
      serviceType: 48,
      pbElem: msgInfo,
      businessType: isGroup ? 20 : 10,
    } as any,
  };
}

async function makePttElem(ctx: SendContext, element: MessageElement): Promise<ProtoElem> {
  const isGroup = ctx.groupId !== undefined;
  const targetIdOrUid = isGroup ? ctx.groupId! : (ctx.userUid ?? '');
  if (!isGroup && !targetIdOrUid) {
    throw new Error('private record target uid is missing');
  }

  const msgInfo = await uploadPttMsgInfo(ctx.bridge, isGroup, targetIdOrUid, element);

  // commonElem.businessType is the QQ NT scene tag the receive-side
  // decoder pairs with: 12=c2c, 22=group. Sending the group tag on a
  // c2c message bounces with PbSendMsg result=79.
  return {
    commonElem: {
      serviceType: 48,
      pbElem: msgInfo,
      businessType: isGroup ? 22 : 12,
    } as any,
  };
}

function makeGroupFileElem(element: MessageElement): ProtoElem {
  // Group file chat element. The OIDB 0x6D6_0 upload + highway PUT only
  // stages the bytes on QQ's side; without this trailing message the
  // file is uploaded but never appears in the chat — that's the
  // "log says uploaded but message is empty" bug the user reported.
  //
  // Wire shape: `Elem.transElem` (field 5) with `elemType=24` and an
  // `elemValue` of `0x01 | BE16(len) | GroupFileExtra(protobuf)`. The
  // 0x01 prefix and BE16 length wrapper match what the receive-side
  // decoder in `msg-push/rich-body-decoder.ts:171-185` already strips.
  if (!element.fileId) throw new Error('file element missing fileId');
  const fileSize = element.fileSize ?? 0;
  const fileName = element.fileName ?? '';
  const md5 = element.md5Hex ? hexToBytes(element.md5Hex) : new Uint8Array(0);
  const sha1 = element.sha1Hex ? hexToBytes(element.sha1Hex) : new Uint8Array(0);

  // Outer field1 is hardcoded to 6 in NapCat's encoder
  // (`packet/message/element.ts:589`). It's a magic tag the server
  // expects on send (acidify ships the same shape via their generic
  // `field1: Int` default but their consumer writes it too). Without
  // these outer fields the current QQ-NT server rejects the message
  // with `result=79`. Inner field5 is the uint32 placeholder both
  // NapCat and acidify leave at 0 — we follow suit.
  const extraBytes = protobuf_encode<GroupFileExtra>({
    field1: 6,
    fileName,
    inner: {
      info: {
        busId: 102,
        fileId: element.fileId,
        fileSize: BigInt(fileSize),
        fileName,
        fileSha: sha1,
        extInfoString: '',
        fileMd5: md5,
      },
    },
  });
  if (extraBytes.length > 0xFFFF) {
    // The 16-bit length prefix caps the payload at 64 KiB; even the
    // densest GroupFileExtra (fileId/name/two hashes) is well under.
    // This is here so a future schema change can't silently truncate.
    throw new Error(`group file extra too large (${extraBytes.length} > 65535)`);
  }
  const elemValue = new Uint8Array(3 + extraBytes.length);
  elemValue[0] = 0x01;
  elemValue[1] = (extraBytes.length >> 8) & 0xff;
  elemValue[2] = extraBytes.length & 0xff;
  elemValue.set(extraBytes, 3);

  return {
    transElem: {
      elemType: 24,
      elemValue,
    } as any,
  };
}

async function makeVideoElem(ctx: SendContext, element: MessageElement): Promise<ProtoElem> {
  const isGroup = ctx.groupId !== undefined;
  const targetIdOrUid = isGroup ? ctx.groupId! : (ctx.userUid ?? '');
  if (!isGroup && !targetIdOrUid) {
    throw new Error('private video target uid is missing');
  }

  const msgInfo = await uploadVideoMsgInfo(ctx.bridge, isGroup, targetIdOrUid, element);

  // commonElem.businessType is the QQ NT scene tag the receive-side
  // decoder pairs with: 11=c2c, 21=group. Sending the group tag on a
  // c2c message bounces with PbSendMsg result=79.
  return {
    commonElem: {
      serviceType: 48,
      pbElem: msgInfo,
      businessType: isGroup ? 21 : 11,
    } as any,
  };
}

/**
 * Build proto Elem objects from an array of MessageElements.
 * Supports: text, face, at, reply, json, xml, markdown, image, record, video, forward.
 * Image, record and video elements trigger NTV2 highway upload via the SendContext.
 */
export async function buildSendElems(elements: MessageElement[], ctx?: SendContext): Promise<ProtoElem[]> {
  const result: ProtoElem[] = [];

  for (const elem of elements) {
    switch (elem.type) {
      case 'text':
        if (elem.text) result.push(makeTextElem(elem.text));
        break;

      case 'face':
        if (elem.faceId !== undefined) result.push(makeFaceElem(elem.faceId));
        break;

      case 'at':
        result.push(makeMentionElem(elem, ctx));
        break;

      case 'reply':
        if (elem.replySeq) result.push(makeReplyElem(elem));
        break;

      case 'json':
        if (elem.text) result.push(makeJsonElem(elem));
        break;

      case 'xml':
        if (elem.text) result.push(makeXmlElem(elem));
        break;

      case 'markdown':
        if (elem.text) result.push(makeMarkdownElem(elem));
        break;

      case 'image':
        if (ctx) {
          result.push(await makeImageElem(ctx, elem));
        } else {
          console.warn('[ElemBuilder] image send requires SendContext');
        }
        break;

      case 'forward':
        if (elem.resId) result.push(makeForwardElem(elem));
        break;

      case 'record':
        if (ctx) {
          result.push(await makePttElem(ctx, elem));
        } else {
          console.warn('[ElemBuilder] record send requires SendContext');
        }
        break;

      case 'video':
        if (ctx) {
          result.push(await makeVideoElem(ctx, elem));
        } else {
          console.warn('[ElemBuilder] video send requires SendContext');
        }
        break;

      case 'file':
        // The group `TransElem(24)` shape works for group chats only.
        // C2C files live on `RichText.notOnlineFile` instead of in the
        // elems array, so `sendPrivateMessage` short-circuits before it
        // ever lands here — see `bridge.sendPrivateMessage`.
        if (ctx?.groupId !== undefined) {
          result.push(makeGroupFileElem(elem));
        } else {
          console.warn('[ElemBuilder] file send via elems[] is group-only; use bridge.sendC2cFileMessage for c2c');
        }
        break;

      default:
        console.warn(`[ElemBuilder] unsupported element type for send: ${elem.type}`);
        break;
    }
  }

  return result;
}
