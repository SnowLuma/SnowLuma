import type {
  MarkdownData,
  MentionExtraSend,
} from '@snowluma/proto-defs/action';
import type { Elem, GroupFileExtra } from '@snowluma/proto-defs/element';
import { protobuf_encode } from '@snowluma/proton';
import { randomUUID } from 'crypto';
import { deflateSync } from 'zlib';
import type { BridgeContext } from './bridge-context';
import type { MessageElement } from './events';
import { uploadImageMsgInfo } from './highway/image-upload';
import { hexToBytes } from './highway/pipeline';
import { uploadPttMsgInfo } from './highway/ptt-upload';
import { uploadVideoMsgInfo } from './highway/video-upload';

type ProtoElem = Partial<Elem>;

export interface SendContext {
  bridge: BridgeContext;
  groupId?: number;
  userUid?: string;
  /**
   * Set by the forward-message upload path. When `true`, file segments
   * are encoded as receive-side wire shapes (group → `transElem(24)`,
   * c2c → caller writes `body.msgContent` separately) instead of being
   * dropped. The QQ-NT server rejects outgoing PbSendMsg with
   * `transElem(24)` (result=79), but the long-msg upload service does
   * NOT — it stores the gzipped protobuf verbatim, so the receiver
   * can walk it back through the regular decoder. Mirrors NapCat's
   * `PacketMsgFileElement.buildElement` + `buildContent` split (see
   * `dev/napcatQQ/.../packet/message/element.ts:530-610`).
   */
  forwardFake?: boolean;
}

function makeTextElem(text: string): ProtoElem {
  return {
    text: { str: text },
  };
}

function makeFaceElem(faceId: number): ProtoElem {
  return {
    face: { index: faceId },
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
    },
  };
}

function makeReplyElem(element: MessageElement): ProtoElem {
  const seq = element.replySeq! & 0xFFFFFFFF;

  const srcMsg: NonNullable<Elem['srcMsg']> = {
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

function makeDeflatedPayload(content: string): Uint8Array {
  const deflated = deflateSync(Buffer.from(content, 'utf8'));
  const payload = new Uint8Array(deflated.length + 1);
  payload[0] = 0x01;
  payload.set(deflated, 1);
  return payload;
}

function makeJsonElem(element: MessageElement): ProtoElem {
  const content = element.text ?? '';

  return {
    lightApp: {
      data: makeDeflatedPayload(content),
    },
  };
}

function makeXmlElem(element: MessageElement): ProtoElem {
  const content = element.text ?? '';

  return {
    richMsg: {
      serviceId: element.subType === 0 ? 35 : (element.subType ?? 35),
      template1: makeDeflatedPayload(content),
    },
  };
}

function makeMarkdownElem(element: MessageElement): ProtoElem {
  const data = protobuf_encode<MarkdownData>({ content: element.text ?? '' });

  return {
    commonElem: {
      serviceType: 45,
      pbElem: data,
      businessType: 1,
    },
  };
}


function makeForwardElem(element: MessageElement): ProtoElem {
  const resId = (element.resId ?? '').trim();
  if (!resId) {
    throw new Error('forward resId is required');
  }

  // `uniseq` MUST round-trip between the preview JSON and the outer
  // upload's piggyback `actionCommand` for nested forwards to resolve
  // without an extra server hit. Generate one fresh if absent (flat
  // forwards don't piggyback anyway, so the value is cosmetic there).
  const uniseq = (element.forwardUuid ?? '').trim() || randomUUID();

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

  // LightApp / `com.tencent.multimsg` is the modern wire shape both
  // QQ-NT, Lagrange.Core, and NapCat emit and decode. The older
  // `richMsg serviceID=35 m_resid=…` XML still renders on mobile QQ
  // but it doesn't carry `uniseq`, so nested forwards lose the link
  // between the inner preview and the piggybacked actions on the
  // outer's LongMsgResult — cross-checked against
  // `dev/Lagrange.Core/.../Message/Entity/MultiMsgEntity.cs:43-115`
  // and `dev/NapCatQQ/.../helper/forward-msg-builder.ts:52-122`.
  const lightApp = {
    app: 'com.tencent.multimsg',
    config: {
      autosize: 1,
      forward: 1,
      round: 1,
      type: 'normal',
      width: 300,
    },
    desc: prompt,
    extra: JSON.stringify({ filename: uniseq, tsum: tSum }),
    meta: {
      detail: {
        news: news.map(n => ({ text: n.text ?? '' })),
        resid: resId,
        source,
        summary,
        uniseq,
      },
    },
    prompt,
    ver: '0.0.0.5',
    view: 'contact',
  };

  const json = JSON.stringify(lightApp);
  return {
    lightApp: {
      data: makeDeflatedPayload(json),
    },
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
    },
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
    },
  };
}

/**
 * Receive-side group file element shape — `transElem(elemType=24,
 * elemValue: 0x01 | BE16(len) | GroupFileExtra)`.
 *
 * NOT used for outgoing PbSendMsg (the QQ-NT server rejects that with
 * result=79); the group-file send-side flow goes through dedicated
 * OIDB 0x6d9_4 via `bridge.apis.groupFile.publish`. This shape IS used
 * inside the long-msg upload (forward / multi-msg) — the long-msg
 * service stores the gzipped protobuf verbatim, and the receiver
 * decodes file entities from `transElem(24)` (see
 * `msg-push/rich-body-decoder.ts:169-187`).
 *
 * `ctx` is consulted to fill in size/name/md5/sha1 from the upload
 * metadata cache when the caller only threaded the file_id through.
 * Mirrors the c2c forward path in `apis/forward.ts::buildForwardPushBody`
 * which already does this lookup — without it the receiver sees a
 * "0 B" file with no name (OneBot11 `{type:'file', file_id}` segments
 * typically omit the metadata since the upload action returned only
 * the id).
 */
function makeGroupFileElem(element: MessageElement, ctx?: SendContext): ProtoElem {
  if (!element.fileId) throw new Error('file element missing fileId');
  const cached = ctx?.bridge.recallUploadedFile(element.fileId);
  const fileSize = element.fileSize ?? cached?.fileSize ?? 0;
  const fileName = element.fileName ?? cached?.fileName ?? '';
  const md5 = element.md5Hex
    ? hexToBytes(element.md5Hex)
    : (cached?.fileMd5 ?? new Uint8Array(0));
  const sha1 = element.sha1Hex
    ? hexToBytes(element.sha1Hex)
    : (cached?.fileSha1 ?? new Uint8Array(0));

  // Outer field1 is hardcoded to 6 in NapCat's encoder
  // (`packet/message/element.ts:589`). Inner GroupFileExtraInfo carries
  // busId=102 + the file_id + name + size + sha1/md5 hashes.
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
    },
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
    },
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
        // Files split into two routes depending on whether this is a
        // live send or a forward-message fake-send:
        //
        // 1. LIVE send (PbSendMsg / OIDB 0x6d9_4) — never carried on
        //    elems[]. The OneBot layer splits file segments off before
        //    calling buildSendElems:
        //      * c2c (private): split → `bridge.sendC2cFileMessage`
        //        (routingHead.trans0x211 + msgContent FileExtra).
        //      * group: split → `bridge.sendGroupFileMessage`
        //        (OIDB 0x6d9_4 publish).
        //    The QQ-NT server REJECTS outgoing PbSendMsg with a
        //    transElem(24) (result=79), so an element reaching here
        //    in live-send mode is a routing bug — drop with a warn.
        //
        // 2. FORWARD-FAKE upload (long-msg) — `ctx.forwardFake===true`.
        //    The long-msg service stores the gzipped protobuf verbatim
        //    and the receiver decodes file entities from transElem(24)
        //    + msgContent FileExtra. Mirror NapCat's split (see
        //    `dev/napcatQQ/.../packet/message/element.ts:530-610`):
        //      * group → emit transElem(24) via makeGroupFileElem
        //      * c2c   → emit NOTHING here; the forward-builder pulls
        //                the file segment off and writes msgContent
        //                separately (because RichText.notOnlineFile +
        //                FileExtra both live outside elems[]).
        if (ctx && ctx.forwardFake) {
          if (ctx.groupId !== undefined) {
            result.push(makeGroupFileElem(elem, ctx));
          }
          // c2c forwardFake intentionally falls through — handled by
          // the forward-builder at the msgContent level.
        } else {
          console.warn('[ElemBuilder] BUG: {type:"file"} reached element-builder — must be split out at the OneBot layer (see modules/message-actions.ts::sendPrivateMessage / ::sendGroupMessage)');
        }
        break;

      default:
        console.warn(`[ElemBuilder] unsupported element type for send: ${elem.type}`);
        break;
    }
  }

  return result;
}
