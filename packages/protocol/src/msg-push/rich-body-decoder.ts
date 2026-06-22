import { protobuf_decode } from '@snowluma/proton';
import { toHex, toHexUpper } from '@snowluma/common/hex';
import type { MessageElement } from '../events';
import type {
  Elem,
  GroupFileExtra,
  MentionExtra,
  MsgInfo,
  NotOnlineImage,
  QFaceExtra,
  QSmallFaceExtra,
} from '@snowluma/proto-defs/element';
import type { FileExtra, MessageBody, PushMsgBody as PushMsgBodyFull, RichText } from '@snowluma/proto-defs/message';
import { decompressData, makeImageUrl } from './helpers';

type ElemDecoded = Elem;
type RichTextDecoded = RichText;
export type PushMsgBody = MessageBody;

export function decodeRichBody(body: PushMsgBody | undefined, isGroup: boolean): MessageElement[] {
  const elements: MessageElement[] = [];
  if (body?.richText) {
    const rt = body.richText;
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
  let skipNext = false;
  // [#127] A QQ NT reply carries the replied sender as a structural auto-mention
  // (MentionExtra.type=2, uin=0) right after srcMsg, followed by a blank
  // separator text. Both are part of the reply wire shape, not user content —
  // drop them so they aren't reported as a spurious @ + empty segment. A real
  // user @ carries a non-zero MentionExtra.uin, so it's preserved.
  let sawReply = false;
  let dropNextBlankText = false;

  for (const elem of elems) {
    if (skipNext) { skipNext = false; continue; }

    // Reply / quote. For a c2c (friend) reply the canonical replied-to sequence
    // is the srcMsg reserve's `friendSequence`, NOT `origSeqs[0]` — origSeqs
    // carries the per-sender clientSequence, which doesn't match how the
    // original message is keyed (by its server/private sequence), so resolving
    // the reply (and get_msg on the quoted message) would miss. Mirrors
    // Lagrange's `Sequence = reserve.FriendSequence ?? OrigSeqs[0]`
    // (ForwardEntity.cs). Group replies keep origSeqs[0] (the shared group seq).
    if (elem.srcMsg) {
      // The reply resolves to srcMsg.origSeqs[0] — for BOTH group (shared group
      // seq) and c2c. On-target capture (#114 / #124) proved origSeqs[0] equals
      // the quoted message's head.sequence, i.e. the seq its message_id is
      // hashed from. reserve.friendSequence is a small friend-relationship
      // counter that does NOT match (e.g. 25 vs a head.sequence of 12707), so
      // the earlier `friendSequence` override made reply.id != the quoted
      // message_id: get_msg(reply_id) missed and a quoted File's content came
      // back empty.
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
          for (const raw of src.elemsRaw) {
            try { decoded.push(protobuf_decode<Elem>(raw)); } catch { /* skip corrupt elem */ }
          }
          if (decoded.length) reply.replyElements = convertElements(decoded);
        }
        // A C2C quoted FILE lives in RichText.notOnlineFile (message level), not
        // in elems[] — recover it from sourceMsg (field 9) when elems carried no
        // file, so a quoted file's content survives into get_msg (#124).
        if (src.sourceMsg?.length && !reply.replyElements?.some((e) => e.type === 'file')) {
          try {
            const pmsg = protobuf_decode<PushMsgBodyFull>(src.sourceMsg);
            const nof = pmsg?.body?.richText?.notOnlineFile;
            if (nof?.fileName) {
              (reply.replyElements ??= []).push({
                type: 'file',
                fileName: nof.fileName,
                fileSize: nof.fileSize !== undefined ? Number(nof.fileSize) : 0,
                fileId: nof.fileUuid ?? '',
              });
            }
          } catch { /* sourceMsg decode is best-effort */ }
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
        mention = protobuf_decode<MentionExtra>(t.pbReserve);
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
        const me: MessageElement = { type: 'at', text: t.str ?? '' };
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
        if (text) result.push({ type: 'text', text });
      }
    }

    // Face
    if (elem.face) {
      result.push({ type: 'face', faceId: elem.face.index ?? 0 });
    }

    // MarketFace (商城表情). Keep the wire identity (`emojiId`/`tabId`/`key`)
    // on the element; the OneBot layer unifies it to an `image` segment with
    // these as markers (NapCat-compatible), and the send path rebuilds the
    // wire `marketFace` from them. `emojiId` is the lowercase hex of the
    // `faceId` GUID bytes — it also forms the gxh gif URL on the segment side.
    if (elem.marketFace) {
      const mf = elem.marketFace;
      result.push({
        type: 'mface',
        text: mf.faceName ?? '',
        emojiId: mf.faceId && mf.faceId.length > 0 ? toHex(mf.faceId) : '',
        emojiPackageId: mf.tabId ?? 0,
        emojiKey: mf.key ?? '',
      });
    }

    // NotOnlineImage (C2C image)
    if (elem.notOnlineImage) {
      const img = elem.notOnlineImage;
      if (img.picMd5 && img.picMd5.length > 0) {
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
      if (img.md5 && img.md5.length > 0) {
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
      if ((te.elemType ?? 0) === 24 && te.elemValue && te.elemValue.length > 3) {
        const val = te.elemValue;
        const len = (val[1] << 8) | val[2];
        if (val.length >= 3 + len) {
          const extra = protobuf_decode<GroupFileExtra>(val.subarray(3, 3 + len));
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
    }

    // RichMsg
    if (elem.richMsg) {
      const rm = elem.richMsg;
      if (rm.template1 && rm.template1.length > 0) {
        const content = decompressData(rm.template1);
        if (content) {
          const svcId = rm.serviceId ?? 0;
          if (svcId === 35) {
            const pos = content.indexOf('m_resid="');
            if (pos !== -1) {
              const start = pos + 9;
              const end = content.indexOf('"', start);
              if (end !== -1) {
                result.push({ type: 'forward', resId: content.substring(start, end) });
                continue;
              }
            }
            result.push({ type: 'xml', text: content, subType: svcId });
          } else if (svcId === 1) {
            result.push({ type: 'json', text: content });
          } else {
            result.push({ type: 'xml', text: content, subType: svcId });
          }
        }
      }
    }

    // LightApp
    if (elem.lightApp) {
      const la = elem.lightApp;
      if (la.data && la.data.length > 0) {
        const content = decompressData(la.data);
        if (content) {
          // `com.tencent.multimsg` is the multi-msg / forward preview
          // LightApp (the modern replacement for the XML serviceID=35
          // shape). Parse out resid + uniseq so downstream callers can
          // both render a `[聊天记录]` placeholder and walk into the
          // forward chain via `fetch(resId)` — the uniseq is what links
          // the inner layer to its piggybacked actions on the outer's
          // LongMsgResult. Other LightApp messages fall through to the
          // generic `{type: 'json'}` path.
          try {
            const parsed = JSON.parse(content);
            if (parsed && parsed.app === 'com.tencent.multimsg') {
              const detail = parsed.meta?.detail ?? {};
              const resId = typeof detail.resid === 'string' ? detail.resid : '';
              const uniseq = typeof detail.uniseq === 'string' ? detail.uniseq : '';
              if (resId) {
                result.push({
                  type: 'forward',
                  resId,
                  forwardUuid: uniseq || undefined,
                });
                continue;
              }
            }
          } catch { /* fall through to generic json element */ }
          result.push({ type: 'json', text: content });
        }
      }
    }

    // CommonElem
    if (elem.commonElem) {
      const ce = elem.commonElem;
      const svcType = ce.serviceType ?? 0;
      const bizType = ce.businessType ?? 0;

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
          const img = protobuf_decode<NotOnlineImage>(pb.subarray(pos, pos + length));
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
        skipNext = true;
      } else if (ce.pbElem && (svcType === 48 || bizType === 10 || bizType === 20 || bizType === 11 || bizType === 21 || bizType === 12 || bizType === 22)) {
        // NTQQ new protocol image/record/video
        const info = protobuf_decode<MsgInfo>(ce.pbElem);
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
              if (fi.fileHash) me.md5Hex = fi.fileHash;
              if (fi.fileSha1) me.sha1Hex = fi.fileSha1;
              if (fi.type?.picFormat) me.picFormat = fi.type.picFormat;
              if (info.extBizInfo?.pic) {
                me.subType = info.extBizInfo.pic.bizType ?? 0;
                me.summary = info.extBizInfo.pic.textSummary
                  || (me.subType === 1 ? '[动画表情]' : '[图片]');
              }
              result.push(me);
            } else if (bizType === 12 || bizType === 22) {
              // Record
              result.push({
                type: 'record', fileName: fi.fileName ?? '',
                fileId: idx.fileUuid ?? '', duration: fi.time ?? 0,
                fileHash: fi.fileHash ?? '',
                fileSize: fi.fileSize ?? 0,
                md5Hex: fi.fileHash ?? '',
                sha1Hex: fi.fileSha1 ?? '',
                voiceFormat: fi.type?.voiceFormat ?? 0,
                mediaNode: {
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
                },
              });
            } else if (bizType === 11 || bizType === 21) {
              // Video
              result.push({
                type: 'video', fileName: fi.fileName ?? '',
                fileId: idx.fileUuid ?? '', fileSize: fi.fileSize ?? 0,
                duration: fi.time ?? 0,
                fileHash: fi.fileHash ?? '',
                width: fi.width ?? 0,
                height: fi.height ?? 0,
                md5Hex: fi.fileHash ?? '',
                sha1Hex: fi.fileSha1 ?? '',
                videoFormat: fi.type?.videoFormat ?? 0,
                mediaNode: {
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
                },
              });
            }
          }
        }
      } else if (svcType === 33 && ce.pbElem) {
        // Small face
        const extra = protobuf_decode<QSmallFaceExtra>(ce.pbElem);
        if (extra) result.push({ type: 'face', faceId: extra.faceId ?? 0 });
      } else if (svcType === 37 && ce.pbElem) {
        // Big face
        const extra = protobuf_decode<QFaceExtra>(ce.pbElem);
        if (extra?.qsid !== undefined) result.push({ type: 'face', faceId: extra.qsid });
        skipNext = true;
      }
    }
  }

  return result;
}

function extractRichtextExtras(
  rt: RichTextDecoded,
  elements: MessageElement[],
  isGroup = false
): void {
  // Ptt (voice)
  if (rt.ptt) {
    const p = rt.ptt;
    const md5Hex = p.fileMd5 && p.fileMd5.length > 0 ? toHexUpper(p.fileMd5) : '';
    const me: MessageElement = {
      type: 'record', fileName: p.fileName ?? '',
      fileSize: p.fileSize ?? 0, duration: p.time ?? 0,
      fileHash: md5Hex,
      md5Hex,
      voiceFormat: p.format ?? 0,
    };
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
  const extra = protobuf_decode<FileExtra>(msgContent);
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
