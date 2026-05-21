import type { BridgeInterface } from '../../bridge/bridge-interface';
import type { ForwardNodePayload, MessageElement } from '../../bridge/events';
import { createLogger } from '@snowluma/common/logger';
import type { MessageSendResult } from '../api-handler';
import { elementsToOneBotSegments } from '../event-converter';
import { segmentsToRawMessage } from '../event-converter/utils';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from '../message-id';
import { parseMessage } from '../message-parser';
import type { MessageStore } from '../message-store';
import type { JsonArray, JsonObject, JsonValue, MessageMeta } from '../types';
import type { OneBotInstanceContext } from '../instance-context';

const log = createLogger('OneBot');

export async function getGroupMsgHistory(
  messageStore: MessageStore,
  groupId: number,
  messageId?: number,
  count?: number,
): Promise<JsonObject[]> {
  if (!Number.isInteger(groupId) || groupId <= 0) return [];
  const limit = normalizeHistoryCount(count);

  let anchorSequence: number | undefined;
  if (Number.isInteger(messageId) && messageId !== 0) {
    const meta = messageStore.findMeta(messageId as number);
    if (!meta || !meta.isGroup || meta.targetId !== groupId || meta.sequence <= 0) return [];
    anchorSequence = meta.sequence;
  }

  const events = messageStore.listSessionEvents(true, groupId, limit, anchorSequence);
  return events
    .filter((event) => {
      if (event.message_type !== 'group') return false;
      const gid = Number(event.group_id ?? 0);
      return Number.isFinite(gid) && Math.trunc(gid) === groupId;
    })
    .map(sanitizeMessageEventForApi);
}

export async function getFriendMsgHistory(
  messageStore: MessageStore,
  userId: number,
  messageId?: number,
  count?: number,
): Promise<JsonObject[]> {
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const limit = normalizeHistoryCount(count);

  let anchorSequence: number | undefined;
  if (Number.isInteger(messageId) && messageId !== 0) {
    const meta = messageStore.findMeta(messageId as number);
    if (!meta || meta.isGroup || meta.targetId !== userId || meta.sequence <= 0) return [];
    anchorSequence = meta.sequence;
  }

  const events = messageStore.listSessionEvents(false, userId, limit, anchorSequence);
  return events
    .filter((event) => {
      if (event.message_type !== 'private') return false;
      const uid = Number(event.user_id ?? 0);
      return Number.isFinite(uid) && Math.trunc(uid) === userId;
    })
    .map(sanitizeMessageEventForApi);
}

export async function deleteMessage(bridge: BridgeInterface, meta: MessageMeta): Promise<void> {
  if (meta.isGroup) {
    await bridge.apis.message.recallGroup(meta.targetId, meta.sequence);
  } else {
    await bridge.apis.message.recallPrivate(
      meta.targetId,
      meta.clientSequence,
      meta.sequence,
      meta.random,
      meta.timestamp,
    );
  }
}

export async function setEssenceMessage(
  bridge: BridgeInterface,
  messageStore: MessageStore,
  messageId: number,
  enable: boolean,
): Promise<void> {
  const meta = messageStore.findMeta(messageId);
  if (!meta || !meta.isGroup) throw new Error('message not found or not a group message');
  await bridge.apis.interaction.setEssence(meta.targetId, meta.sequence, meta.random, enable);
}

/**
 * Build + store a synthetic OneBot event for a just-sent message so
 * `/get_msg` can find it.
 *
 * The QQ server doesn't always echo self-sent messages back on the
 * receive channel — Lagrange and NapCat both work around this by
 * writing a local copy at send time (Lagrange persists into Realm DB
 * inside `SendMessageOperation`; NapCat caches in-memory via its msg
 * service). Without it, callers that hit `/get_msg` with a freshly-
 * returned `message_id` get "message not found" even though the recall
 * path works fine (recall uses the lighter `cacheMessageMeta` already).
 *
 * Stored event has `post_type: 'message_sent'` so OneBot clients that
 * inspect it through `/get_msg` can distinguish their own outbound
 * messages from incoming ones.
 */
async function cacheSelfSentMessage(
  ref: OneBotInstanceContext,
  options: {
    isGroup: boolean;
    sessionId: number;       // groupId or peer userId
    messageId: number;
    sequence: number;
    timestamp: number;
    elements: MessageElement[];
  },
): Promise<void> {
  const { isGroup, sessionId, messageId, sequence, timestamp, elements } = options;
  if (!Number.isInteger(messageId) || messageId === 0) return;

  // Defensive: tests mock `ref.messageStore` as `{ findEvent: ... } as any`
  // without the full MessageStore surface. Production always has it. Bail
  // quietly when the helper isn't there — the user-visible `cacheMessageMeta`
  // already covers recall/delete; only `/get_msg` lookup degrades.
  const storeEvent = (ref.messageStore as { storeEvent?: typeof ref.messageStore.storeEvent }).storeEvent;
  if (typeof storeEvent !== 'function') return;

  try {
    // We deliberately pass no URL resolvers — for a synthetic self-sent
    // event the file/url fields in segments are best-effort (they're
    // already what the OneBot caller passed in). Image/video URLs would
    // need a real resolver to render in `/get_msg`, but the existing
    // resolver is async and bound to the receive pipeline; skipping it
    // means /get_msg returns the segment with the original `file` path
    // and an empty `url`, which is what Lagrange does too.
    const segments = await elementsToOneBotSegments(elements, isGroup, sessionId) as JsonArray;
    const raw = segmentsToRawMessage(segments);
    const eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;
    const selfId = ref.selfId;

    const event: JsonObject = {
      time: timestamp,
      self_id: selfId,
      post_type: 'message_sent',
      message_type: isGroup ? 'group' : 'private',
      sub_type: isGroup ? 'normal' : 'friend',
      message_id: messageId,
      message_seq: sequence,
      user_id: selfId,                                  // sender = self
      message: segments,
      raw_message: raw,
      font: 0,
      sender: {
        user_id: selfId,
        nickname: '',
        sex: 'unknown',
        age: 0,
      },
    };
    if (isGroup) {
      event.group_id = sessionId;
    } else {
      // c2c: target_id mirrors NapCat's `targetUin` field for self-sent
      // events; some OneBot clients use it to disambiguate self-sent
      // private messages (where user_id is self, not the peer).
      event.target_id = sessionId;
    }

    // Store directly via messageStore (bypassing dispatchEvent — we
    // don't want to broadcast this synthetic event over the WS bridge;
    // the QQ server's own echo-back is the source of truth for that).
    storeEvent.call(ref.messageStore, messageId, isGroup, sessionId, sequence, eventName, event);
  } catch (err) {
    // Never let event-cache failures sink the send call — recall + return
    // value are what callers care about; /get_msg degrading to "not found"
    // is the worst case here and matches the previous behaviour.
    log.warn('[OneBot] failed to cache self-sent message %d: %s',
      messageId, err instanceof Error ? err.message : String(err));
  }
}

export async function sendPrivateMessage(
  ref: OneBotInstanceContext,
  userId: number,
  message: JsonValue,
  autoEscape: boolean,
): Promise<MessageSendResult> {
  const elements = await parseMessage(message, autoEscape, {
    resolveReplySequence: (replyMessageId) => {
      return ref.messageStore.resolveReplySequence(false, userId, replyMessageId);
    },
    resolveReplyMeta: (replyMessageId) => {
      // Prefer the cached event (it carries the REAL sender). When only
      // meta exists — typically because the message we're replying to was
      // sent by the bot itself and never round-tripped through dispatch
      // (reportSelfMessage off / no message_sent event) — fall back to
      // selfId. The previous code used `meta.targetId` here, which is the
      // conversation PEER and shows the wrong "回复 @某人" in QQ for any
      // self-reply.
      const event = ref.messageStore.findEvent(replyMessageId);
      if (event) {
        const senderUin = typeof event.user_id === 'number'
          ? event.user_id
          : parseInt(String(event.user_id || '0'), 10);
        const time = typeof event.time === 'number'
          ? event.time
          : parseInt(String(event.time || '0'), 10);
        const meta = ref.messageStore.findMeta(replyMessageId);
        return {
          senderUin,
          time,
          random: meta?.random ?? 0,
        };
      }
      const meta = ref.messageStore.findMeta(replyMessageId);
      if (meta) {
        return {
          senderUin: ref.selfId,
          time: meta.timestamp,
          random: meta.random,
        };
      }
      return null;
    },
    resolveMentionUid: (targetUin) => ref.bridge.resolveUserUid(targetUin),
    musicSignUrl: ref.musicSignUrl,
  });
  if (elements.length === 0) throw new Error('message is empty');

  // C2C `{type:'file'}` segments can't ride on the elems[] pipeline —
  // c2c files live on `RichText.notOnlineFile`, parallel to elems
  // (see `@snowluma/proto-defs/message:notOnlineFile`). The element-builder
  // explicitly drops them with a warn ("file send via elems[] is
  // group-only"), so a private message that bundled a file alongside
  // anything else used to either ship as "[空消息]" (only-file case,
  // 0 elements after drop) or silently lose the file (mixed case).
  //
  // NapCat splits the same way (`dev/NapCatQQ/.../SendMsg.ts:404-415`):
  // FILE / VIDEO / ARK / PTT each go in their own sendMsg call,
  // never mixed with the regular elements. We only need it for file
  // here — video/ARK/ptt already go through commonElem so the
  // element-builder handles them inline.
  const fileElements = elements.filter(e => e.type === 'file' && e.fileId);
  const nonFileElements = elements.filter(e => e.type !== 'file');
  if (fileElements.length !== elements.filter(e => e.type === 'file').length) {
    log.warn('[OneBot] private file segment without file_id — skipped (upload first via upload_private_file)');
  }

  let lastReceipt: Awaited<ReturnType<typeof ref.bridge.apis.message.sendPrivate>> | undefined;
  if (nonFileElements.length > 0) {
    lastReceipt = await ref.bridge.apis.message.sendPrivate(userId, nonFileElements);
    logSentMessage(false, userId, nonFileElements);
  }
  if (fileElements.length > 0) {
    // C2C file send needs the recipient's UID — resolve once and reuse.
    const userUid = await ref.bridge.resolveUserUid(userId);
    if (!userUid) {
      throw new Error(`c2c file send: could not resolve uid for user ${userId}`);
    }
    for (const fileEl of fileElements) {
      // C2C file send requires fileSize/fileMd5/fileName to ride on the
      // wire (NotOnlineFile inside msgContent). The OneBot caller
      // usually only echoes the file_id from a previous
      // `upload_private_file`, so look up the rest from the upload
      // cache. Inline segment fields (md5/size/name) take precedence so
      // a caller that already knows everything can bypass the cache.
      const cached = ref.bridge.recallUploadedFile(fileEl.fileId!);
      const fileMd5 = fileEl.md5Hex
        ? Buffer.from(fileEl.md5Hex, 'hex')
        : (cached?.fileMd5 ?? new Uint8Array(0));
      const fileSize = fileEl.fileSize ?? cached?.fileSize ?? 0;
      // Fall back to a generic name — the QQ server resolves the
      // file by fileUuid, not name, so a missing name only affects
      // the chat bubble display.
      const fileName = fileEl.fileName ?? cached?.fileName ?? 'file';
      const fileHash = fileEl.fileHash ?? cached?.fileHash;
      if (fileSize === 0 && !cached) {
        log.warn(
          '[OneBot] c2c file_id=%s sent without fileSize and no upload cache — recipient may see 0 B',
          fileEl.fileId,
        );
      }
      lastReceipt = await ref.bridge.apis.message.sendC2cFile(userId, userUid, {
        fileId: fileEl.fileId!,
        fileName,
        fileSize,
        fileMd5,
        fileHash,
      });
      logSentMessage(false, userId, [fileEl]);
    }
  }
  if (!lastReceipt) throw new Error('message is empty');

  const messageId = hashMessageIdInt32(lastReceipt.sequence, userId, PRIVATE_MESSAGE_EVENT);
  ref.cacheMessageMeta(messageId, {
    isGroup: false,
    targetId: userId,
    sequence: lastReceipt.sequence,
    eventName: PRIVATE_MESSAGE_EVENT,
    clientSequence: lastReceipt.clientSequence,
    random: lastReceipt.random,
    timestamp: lastReceipt.timestamp,
  });
  await cacheSelfSentMessage(ref, {
    isGroup: false,
    sessionId: userId,
    messageId,
    sequence: lastReceipt.sequence,
    timestamp: lastReceipt.timestamp,
    elements,
  });

  return { messageId };
}

export async function sendGroupMessage(
  ref: OneBotInstanceContext,
  groupId: number,
  message: JsonValue,
  autoEscape: boolean,
): Promise<MessageSendResult> {
  const elements = await parseMessage(message, autoEscape, {
    resolveReplySequence: (replyMessageId) => {
      return ref.messageStore.resolveReplySequence(true, groupId, replyMessageId);
    },
    resolveReplyMeta: (replyMessageId) => {
      const event = ref.messageStore.findEvent(replyMessageId);
      if (event) {
        return {
          senderUin: typeof event.user_id === 'number'
            ? event.user_id
            : parseInt(String(event.user_id || '0'), 10),
          time: typeof event.time === 'number'
            ? event.time
            : parseInt(String(event.time || '0'), 10),
          random: 0,
        };
      }
      return null;
    },
    resolveMentionUid: (targetUin) => ref.bridge.resolveUserUid(targetUin, groupId),
    musicSignUrl: ref.musicSignUrl,
  });
  if (elements.length === 0) throw new Error('message is empty');

  // Group `{type:'file', file_id}` segments don't ride on the elems[]
  // pipeline either. The QQ-NT server rejects PbSendMsg with a
  // transElem(24) file payload (result=79); the correct send path is a
  // dedicated OIDB call (`OidbSvcTrpcTcp.0x6d9_4`) that publishes a
  // previously-uploaded file id as a chat bubble. Mirrors the c2c-file
  // split below (private path) — both must be peeled off before the
  // regular sendGroupMessage runs.
  const fileElements = elements.filter(e => e.type === 'file' && e.fileId);
  const nonFileElements = elements.filter(e => e.type !== 'file');
  if (fileElements.length !== elements.filter(e => e.type === 'file').length) {
    log.warn('[OneBot] group file segment without file_id — skipped (upload first via upload_group_file)');
  }

  let lastReceipt: Awaited<ReturnType<typeof ref.bridge.apis.message.sendGroup>> | undefined;
  if (nonFileElements.length > 0) {
    lastReceipt = await ref.bridge.apis.message.sendGroup(groupId, nonFileElements);
    logSentMessage(true, groupId, nonFileElements);
  }
  for (const fileEl of fileElements) {
    // Group-file publish has no per-message sequence/random tuple to
    // hash a messageId from — OIDB 0x6d9_4 is fire-and-forget on the
    // wire. If this is the LAST element we still need a receipt so
    // the OneBot caller can cache the id; synthesise one from the
    // file_id hash + a fresh timestamp.
    await ref.bridge.apis.groupFile.publish(groupId, fileEl.fileId!);
    logSentMessage(true, groupId, [fileEl]);
    if (!lastReceipt) {
      // Use a hash of the fileId as a stable pseudo-id; this gets
      // mixed with groupId in `hashMessageIdInt32` below.
      let h = 0;
      const s = fileEl.fileId ?? '';
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      }
      lastReceipt = {
        messageId: 0,
        sequence: h & 0x7FFFFFFF,
        clientSequence: 0,
        random: h & 0x7FFFFFFF,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
  }
  if (!lastReceipt) throw new Error('message is empty');

  const messageId = hashMessageIdInt32(lastReceipt.sequence, groupId, GROUP_MESSAGE_EVENT);
  ref.cacheMessageMeta(messageId, {
    isGroup: true,
    targetId: groupId,
    sequence: lastReceipt.sequence,
    eventName: GROUP_MESSAGE_EVENT,
    clientSequence: lastReceipt.clientSequence,
    random: lastReceipt.random,
    timestamp: lastReceipt.timestamp,
  });
  await cacheSelfSentMessage(ref, {
    isGroup: true,
    sessionId: groupId,
    messageId,
    sequence: lastReceipt.sequence,
    timestamp: lastReceipt.timestamp,
    elements,
  });

  return { messageId };
}

export interface ForwardPreviewMeta {
  source?: string;
  summary?: string;
  prompt?: string;
  news?: Array<{ text: string }>;
}

export async function sendGroupForwardMessage(
  ref: OneBotInstanceContext,
  groupId: number,
  messages: JsonValue,
  meta?: ForwardPreviewMeta,
): Promise<{ messageId: number; forwardId: string }> {
  // Thread `groupId` into the parser so any nested forward inside a
  // node's content uploads its inner forward against the same group
  // namespace — otherwise the ARK card's res_id won't be resolvable
  // when the recipient taps to expand.
  const nodes = await parseForwardNodes(ref, messages, { groupId });
  const forwardId = await ref.bridge.apis.forward.upload(nodes, groupId);
  const previewElement = buildForwardPreviewElement(forwardId, nodes, true, meta);
  const receipt = await ref.bridge.apis.message.sendGroup(groupId, [previewElement]);
  const messageId = hashMessageIdInt32(receipt.sequence, groupId, GROUP_MESSAGE_EVENT);

  ref.cacheMessageMeta(messageId, {
    isGroup: true,
    targetId: groupId,
    sequence: receipt.sequence,
    eventName: GROUP_MESSAGE_EVENT,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
  });
  await cacheSelfSentMessage(ref, {
    isGroup: true,
    sessionId: groupId,
    messageId,
    sequence: receipt.sequence,
    timestamp: receipt.timestamp,
    elements: [previewElement],
  });

  return { messageId, forwardId };
}

export async function sendPrivateForwardMessage(
  ref: OneBotInstanceContext,
  userId: number,
  messages: JsonValue,
  meta?: ForwardPreviewMeta,
): Promise<{ messageId: number; forwardId: string }> {
  const nodes = await parseForwardNodes(ref, messages, { userId });
  // userId is plumbed through so inner image/record/video can be uploaded
  // under the recipient's scene (otherwise the OIDB private-image upload
  // has no target uid and the element builder bails).
  const forwardId = await ref.bridge.apis.forward.upload(nodes, undefined, userId);
  const previewElement = buildForwardPreviewElement(forwardId, nodes, false, meta);
  const receipt = await ref.bridge.apis.message.sendPrivate(userId, [previewElement]);
  const messageId = hashMessageIdInt32(receipt.sequence, userId, PRIVATE_MESSAGE_EVENT);

  ref.cacheMessageMeta(messageId, {
    isGroup: false,
    targetId: userId,
    sequence: receipt.sequence,
    eventName: PRIVATE_MESSAGE_EVENT,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
  });
  await cacheSelfSentMessage(ref, {
    isGroup: false,
    sessionId: userId,
    messageId,
    sequence: receipt.sequence,
    timestamp: receipt.timestamp,
    elements: [previewElement],
  });

  return { messageId, forwardId };
}

export async function uploadForwardMessage(
  ref: OneBotInstanceContext,
  messages: JsonValue,
  groupId?: number,
): Promise<{ forwardId: string }> {
  const nodes = await parseForwardNodes(ref, messages, { groupId });
  // groupId controls the resId namespace (group vs private). Without it,
  // a resId minted here is unusable when later sent into a group.
  const forwardId = await ref.bridge.apis.forward.upload(nodes, groupId);
  return { forwardId };
}

/**
 * Forward a previously-received message to another peer.
 *
 * We look up the cached event + media fingerprints, then re-send via the
 * normal send pipeline with `noByteFallback` set on media elements so the
 * upload modules fast-path through OIDB md5/sha1 instead of re-downloading
 * the original CDN bytes. Fails fast if a media segment has no cached
 * fingerprints or contains a file segment (file forwarding has its own
 * separate protocol and is not in scope here).
 */
export async function forwardSingleMessage(
  ref: OneBotInstanceContext,
  messageId: number,
  target: { groupId?: number; userId?: number },
): Promise<{ messageId: number }> {
  if (!target.groupId && !target.userId) {
    throw new Error('forward target group_id or user_id is required');
  }

  const event = ref.messageStore.findEvent(messageId);
  if (!event) throw new Error(`message not found: ${messageId}`);

  const content = (event.message ?? event.raw_message ?? '') as JsonValue;
  const parsed = await parseMessage(content, false);
  if (parsed.length === 0) throw new Error('message has no content');

  const elements = parsed.map((el) => enrichForForward(ref, el));

  let receipt;
  let messageIdOut: number;
  if (target.groupId) {
    receipt = await ref.bridge.apis.message.sendGroup(target.groupId, elements);
    messageIdOut = hashMessageIdInt32(receipt.sequence, target.groupId, GROUP_MESSAGE_EVENT);
    ref.cacheMessageMeta(messageIdOut, {
      isGroup: true,
      targetId: target.groupId,
      sequence: receipt.sequence,
      eventName: GROUP_MESSAGE_EVENT,
      clientSequence: receipt.clientSequence,
      random: receipt.random,
      timestamp: receipt.timestamp,
    });
    await cacheSelfSentMessage(ref, {
      isGroup: true,
      sessionId: target.groupId,
      messageId: messageIdOut,
      sequence: receipt.sequence,
      timestamp: receipt.timestamp,
      elements,
    });
  } else {
    receipt = await ref.bridge.apis.message.sendPrivate(target.userId!, elements);
    messageIdOut = hashMessageIdInt32(receipt.sequence, target.userId!, PRIVATE_MESSAGE_EVENT);
    ref.cacheMessageMeta(messageIdOut, {
      isGroup: false,
      targetId: target.userId!,
      sequence: receipt.sequence,
      eventName: PRIVATE_MESSAGE_EVENT,
      clientSequence: receipt.clientSequence,
      random: receipt.random,
      timestamp: receipt.timestamp,
    });
    await cacheSelfSentMessage(ref, {
      isGroup: false,
      sessionId: target.userId!,
      messageId: messageIdOut,
      sequence: receipt.sequence,
      timestamp: receipt.timestamp,
      elements,
    });
  }

  return { messageId: messageIdOut };
}

function enrichForForward(ref: OneBotInstanceContext, element: MessageElement): MessageElement {
  // The send path takes care of these as-is; nothing extra to do.
  if (element.type === 'text' || element.type === 'face' || element.type === 'at'
    || element.type === 'reply' || element.type === 'json' || element.type === 'xml'
    || element.type === 'poke' || element.type === 'forward' || element.type === 'mface') {
    return element;
  }

  // The `file` segment is its own upload pipeline (FtnUpload / OfflineFile)
  // and is not supported by the fast-upload forward path.
  if (element.type === 'file') {
    throw new Error('forward of file segment is not supported');
  }

  // For images/records/videos we look up the cached fingerprints by any of
  // the keys MediaStore aliases under. After parseMessage, the segment's
  // `data.file` lands on `element.url` for all three types.
  const lookupKey = element.url || element.fileName || element.fileId || '';
  if (!lookupKey) {
    throw new Error(`forward ${element.type} missing cache key`);
  }

  if (element.type === 'image') {
    const cached = ref.mediaStore.findImage(lookupKey);
    if (!cached || !cached.md5Hex || !cached.sha1Hex || !cached.width || !cached.height || !cached.picFormat) {
      throw new Error('forward image fingerprint not cached (legacy image or expired)');
    }
    return {
      ...element,
      type: 'image',
      noByteFallback: true,
      md5Hex: cached.md5Hex,
      sha1Hex: cached.sha1Hex,
      fileSize: cached.fileSize,
      fileName: cached.fileName,
      subType: cached.subType,
      summary: cached.summary,
      width: cached.width,
      height: cached.height,
      picFormat: cached.picFormat,
    };
  }

  if (element.type === 'record') {
    const cached = ref.mediaStore.findRecord(lookupKey);
    if (!cached || !cached.md5Hex || !cached.sha1Hex) {
      throw new Error('forward record fingerprint not cached');
    }
    return {
      ...element,
      type: 'record',
      noByteFallback: true,
      md5Hex: cached.md5Hex,
      sha1Hex: cached.sha1Hex,
      fileSize: cached.fileSize,
      fileName: cached.fileName,
      fileId: cached.fileId,
      duration: cached.duration,
      voiceFormat: cached.voiceFormat ?? 1,
    };
  }

  if (element.type === 'video') {
    const cached = ref.mediaStore.findVideo(lookupKey);
    if (!cached || !cached.md5Hex || !cached.sha1Hex) {
      throw new Error('forward video fingerprint not cached');
    }
    log.warn('video forward uses a fallback thumbnail (original thumb not cached)');
    return {
      ...element,
      type: 'video',
      noByteFallback: true,
      md5Hex: cached.md5Hex,
      sha1Hex: cached.sha1Hex,
      fileSize: cached.fileSize,
      fileName: cached.fileName,
      fileId: cached.fileId,
      duration: cached.duration,
      width: cached.width ?? 0,
      height: cached.height ?? 0,
      videoFormat: cached.videoFormat ?? 0,
    };
  }

  return element;
}

export async function getForwardMessage(
  ref: OneBotInstanceContext,
  resId: string,
): Promise<JsonObject[]> {
  const nodes = await ref.bridge.apis.forward.fetch(resId);
  const results: JsonObject[] = [];
  for (const node of nodes) {
    const isGroup = node.messageType === 'group' || (node.groupId !== undefined && node.groupId > 0);
    const sessionId = isGroup ? (node.groupId ?? 0) : node.userUin;
    const segments = await elementsToOneBotSegments(node.elements, isGroup, sessionId);

    const sender: JsonObject = {
      user_id: node.userUin,
      nickname: node.nickname,
    };
    if (isGroup) sender.card = node.senderCard ?? '';

    const message: JsonObject = {
      self_id: ref.selfId,
      user_id: node.userUin,
      time: node.time ?? Math.floor(Date.now() / 1000),
      message_id: node.msgId ?? 0,
      message_seq: node.msgSeq ?? node.msgId ?? 0,
      real_id: node.msgId ?? 0,
      message_type: isGroup ? 'group' : 'private',
      sender,
      raw_message: '',
      font: 14,
      sub_type: isGroup ? 'normal' : 'friend',
      message: segments as unknown as JsonValue,
      message_format: 'array',
      post_type: 'message',
    };
    if (isGroup && node.groupId !== undefined && node.groupId > 0) {
      message.group_id = node.groupId;
    }
    results.push(message);
  }
  return results;
}

function normalizeHistoryCount(count?: number): number {
  if (!Number.isFinite(count)) return 20;
  const n = Math.trunc(count as number);
  if (n <= 0) return 20;
  if (n > 200) return 200;
  return n;
}

function sanitizeMessageEventForApi(event: JsonObject): JsonObject {
  const result: JsonObject = { ...event };
  delete result.post_type;
  delete result.self_id;
  result.real_id = (result.message_id ?? 0) as JsonValue;
  return result;
}

function logSentMessage(isGroup: boolean, targetId: number, elements: MessageElement[]): void {
  const type = isGroup ? '群聊' : '私聊';
  const parts: string[] = [];

  const replyElem = elements.find(e => e.type === 'reply');
  if (replyElem?.replyMessageId) {
    parts.push(`[回复:${replyElem.replyMessageId}]`);
  }

  for (const elem of elements) {
    if (elem.type === 'reply') continue;

    switch (elem.type) {
      case 'text':
        if (elem.text) {
          const preview = elem.text.length > 50 ? `${elem.text.substring(0, 50)}...` : elem.text;
          parts.push(preview);
        }
        break;
      case 'image':
        parts.push('[图片]');
        break;
      case 'face':
        parts.push('[表情]');
        break;
      case 'at':
        if (elem.text) parts.push(elem.text.trim());
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'json':
        parts.push('[JSON消息]');
        break;
      case 'xml':
        parts.push('[XML消息]');
        break;
      case 'markdown':
        parts.push('[Markdown]');
        break;
      case 'forward':
        parts.push('[转发消息]');
        break;
      case 'poke':
        parts.push('[戳一戳]');
        break;
      case 'file':
        // Avoid the misleading "[空消息]" the user previously saw when
        // sending a file segment — the message is NOT empty, it's a
        // file post. Show the name (or id as fallback) so the log
        // reflects what actually went out.
        parts.push(`[文件:${elem.fileName || elem.fileId || ''}]`);
        break;
      default:
        break;
    }
  }

  const content = parts.join(' ').trim() || '[空消息]';
  log.info(`${type} ${targetId} | 发送：${content}`);
}

// Cap forward nesting at the same depth NapCat uses
// (`SendMsg.ts:225-228`). QQ NT itself renders only a few levels of
// nested forward bubbles before collapsing into "查看更多" — going
// deeper just wastes long-msg uploads and increases the odds of one
// inner upload timing out and aborting the whole tree.
const MAX_FORWARD_DEPTH = 3;

interface ParseForwardOptions {
  /** Destination group, when the parent forward is going to a group. */
  groupId?: number;
  /** Destination user, when the parent forward is going to a c2c peer. */
  userId?: number;
  /** Internal: current recursion depth. Callers should leave this 0. */
  depth?: number;
}

/**
 * Are all entries of this array `{type:'node'}` segments? Then `content`
 * itself is a nested forward chain (vs a regular flat segment list).
 * Mixed content (some nodes + some text/image) returns false: that's
 * not a meaningful protocol shape, so we treat it as flat-segment and
 * let the node entries fall through to parseMessage (which drops them
 * with a warning).
 */
function isNestedNodeArray(value: JsonValue): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const item of value) {
    const seg = asJsonObject(item);
    if (!seg || String(seg.type ?? '') !== 'node') return false;
  }
  return true;
}

async function parseForwardNodes(
  ref: OneBotInstanceContext,
  messages: JsonValue,
  options: ParseForwardOptions = {},
): Promise<ForwardNodePayload[]> {
  const depth = options.depth ?? 0;
  if (depth >= MAX_FORWARD_DEPTH) {
    throw new Error(`forward nesting depth exceeds ${MAX_FORWARD_DEPTH}`);
  }

  if (!Array.isArray(messages)) {
    throw new Error('forward messages must be an array');
  }

  const nodes: ForwardNodePayload[] = [];
  for (const item of messages) {
    const segment = asJsonObject(item);
    if (!segment) continue;

    let nodeData: JsonObject | null = null;
    if (String(segment.type ?? '') === 'node') {
      nodeData = asJsonObject(segment.data);
    } else if (segment.content !== undefined || segment.message !== undefined) {
      nodeData = segment;
    }
    if (!nodeData) continue;

    const messageId = toPositiveInt(nodeData.id ?? nodeData.message_id);
    if (messageId > 0) {
      const event = ref.messageStore.findEvent(messageId);
      if (!event) throw new Error(`forward node message_id not found: ${messageId}`);

      const eventSender = asJsonObject(event.sender) ?? {};
      const senderCard = eventSender.card !== undefined ? String(eventSender.card) : undefined;
      const nickname = String(eventSender.card ?? eventSender.nickname ?? nodeData.nickname ?? nodeData.name ?? '');
      const userUin = toPositiveInt(event.user_id);
      const content = (event.message ?? event.raw_message ?? '') as JsonValue;
      const elements = await parseMessage(content, false);
      if (userUin > 0 && elements.length > 0) {
        const messageType = event.message_type === 'group' ? 'group' : 'private';
        const groupIdValue = toPositiveInt(event.group_id);
        nodes.push({
          userUin,
          nickname: nickname || String(userUin),
          elements,
          time: typeof event.time === 'number' ? event.time : toPositiveInt(event.time),
          msgId: toPositiveInt(event.message_id),
          msgSeq: toPositiveInt(event.message_seq),
          groupId: groupIdValue > 0 ? groupIdValue : undefined,
          senderCard,
          messageType,
        });
      }
      continue;
    }

    const userUin = toPositiveInt(nodeData.user_id ?? nodeData.uin);
    if (userUin <= 0) throw new Error('forward node user_id/uin is required');

    const nickname = String(nodeData.nickname ?? nodeData.name ?? userUin);
    const content = (nodeData.content ?? nodeData.message ?? '') as JsonValue;

    let elements: MessageElement[];
    let innerForward: ForwardNodePayload[] | undefined;
    if (isNestedNodeArray(content)) {
      // Nested forward chain — `content` is itself a list of `{type:'node'}`
      // segments. We recursively parse them into a sibling
      // `ForwardNodePayload[]` and attach it to this node as `innerForward`.
      // `uploadForwardNodes` then drives the recursive upload + ARK-preview
      // generation + msgBody piggyback in one pass over the whole tree.
      //
      // Why hand it off instead of uploading here: NapCat (`dev/NapCatQQ/
      // .../SendMsg.uploadForwardedNodesPacket`) carries every inner level's
      // packetMsg up to the outermost long-msg upload as extra
      // `actionCommand` slots, so the receiver gets the whole tree from one
      // server fetch. That cross-layer piggyback needs the upload pipeline
      // to own the recursion — doing it in `parseForwardNodes` would force
      // each level to do its own independent long-msg upload, which is what
      // the previous implementation did and what a NapCat-compatible
      // receiver couldn't walk.
      innerForward = await parseForwardNodes(ref, content, {
        groupId: options.groupId,
        userId: options.userId,
        depth: depth + 1,
      });
      // Placeholder — `uploadForwardNodes` replaces these with a real
      // forward-preview MessageElement once it has the inner res_id +
      // uuid in hand.
      elements = [];
    } else {
      elements = await parseMessage(content, false);
    }
    if (!innerForward && elements.length === 0) {
      throw new Error(`forward node content is empty: ${userUin}`);
    }

    const node: ForwardNodePayload = { userUin, nickname, elements };
    if (innerForward) node.innerForward = innerForward;
    nodes.push(node);
  }

  if (nodes.length === 0) {
    throw new Error('forward node list is empty');
  }
  return nodes;
}

// Per-element preview string for the forward bubble's `news` lines.
// Mirrors NapCat's `PacketMsg.toPreview()` mapping; keeps text trim short
// so a chain of segments doesn't blow past the bubble's 80-char display.
function elementPreview(element: MessageElement): string {
  switch (element.type) {
    case 'text': {
      const t = element.text ?? '';
      return t.length > 40 ? `${t.slice(0, 40)}…` : t;
    }
    case 'at': return element.text?.trim() || '@';
    case 'face': return '[表情]';
    case 'mface': return element.text ? `[${element.text}]` : '[表情]';
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return element.fileName ? `[文件:${element.fileName}]` : '[文件]';
    case 'reply': return '';
    case 'json': return '[JSON消息]';
    case 'xml': return '[XML消息]';
    case 'markdown': return '[Markdown]';
    case 'forward': return '[聊天记录]';
    case 'poke': return '[戳一戳]';
    default: return '';
  }
}

function buildNewsFromNodes(nodes: ForwardNodePayload[]): Array<{ text: string }> {
  // Match NapCat ForwardMsgBuilder: each line is "<nickname>: <preview>".
  // Cap to the first 4 lines — that's what QQ's bubble can actually render
  // before it truncates; anything beyond is silently dropped by the client.
  const lines: Array<{ text: string }> = [];
  for (const node of nodes) {
    const preview = node.elements.map(elementPreview).filter(Boolean).join(' ').trim();
    const nickname = node.nickname || String(node.userUin);
    lines.push({ text: `${nickname}: ${preview || '[消息]'}` });
    if (lines.length >= 4) break;
  }
  return lines;
}

function deriveForwardSource(nodes: ForwardNodePayload[], isGroup: boolean): string {
  if (nodes.length === 0) return '聊天记录';
  if (isGroup) return '群聊的聊天记录';
  // Private chat: stitch up to 4 distinct sender nicks, NapCat-style.
  const seen = new Set<string>();
  const nicks: string[] = [];
  for (const node of nodes) {
    const nick = (node.nickname || String(node.userUin)).trim();
    if (!nick || seen.has(nick)) continue;
    seen.add(nick);
    nicks.push(nick);
    if (nicks.length >= 4) break;
  }
  return nicks.length > 0 ? `${nicks.join('和')}的聊天记录` : '聊天记录';
}

function buildForwardPreviewElement(
  resId: string,
  nodes: ForwardNodePayload[],
  isGroup: boolean,
  meta: ForwardPreviewMeta | undefined,
): MessageElement {
  const news = meta?.news && meta.news.length > 0 ? meta.news : buildNewsFromNodes(nodes);
  const source = meta?.source && meta.source.length > 0
    ? meta.source
    : deriveForwardSource(nodes, isGroup);
  const summary = meta?.summary && meta.summary.length > 0
    ? meta.summary
    : `查看${nodes.length}条转发消息`;
  const prompt = meta?.prompt && meta.prompt.length > 0 ? meta.prompt : '[聊天记录]';

  return {
    type: 'forward',
    resId,
    forwardSource: source,
    forwardSummary: summary,
    forwardPrompt: prompt,
    forwardNews: news,
    forwardTSum: nodes.length,
  };
}

function asJsonObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function toPositiveInt(value: JsonValue | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed));
  }
  return 0;
}
