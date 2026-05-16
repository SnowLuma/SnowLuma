import type { BridgeInterface } from '../../bridge/bridge-interface';
import type { ForwardNodePayload, MessageElement } from '../../bridge/events';
import { createLogger } from '../../utils/logger';
import type { MessageSendResult } from '../api-handler';
import { elementsToOneBotSegments } from '../event-converter';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from '../message-id';
import { parseMessage } from '../message-parser';
import type { MessageStore } from '../message-store';
import type { JsonObject, JsonValue, MessageMeta } from '../types';
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
    await bridge.recallGroupMessage(meta.targetId, meta.sequence);
  } else {
    await bridge.recallPrivateMessage(
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
  await bridge.setGroupEssence(meta.targetId, meta.sequence, meta.random, enable);
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
      const meta = ref.messageStore.findMeta(replyMessageId);
      if (meta) {
        return {
          senderUin: meta.targetId,
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

  const receipt = await ref.bridge.sendPrivateMessage(userId, elements);
  const messageId = hashMessageIdInt32(receipt.sequence, userId, PRIVATE_MESSAGE_EVENT);

  logSentMessage(false, userId, elements);

  ref.cacheMessageMeta(messageId, {
    isGroup: false,
    targetId: userId,
    sequence: receipt.sequence,
    eventName: PRIVATE_MESSAGE_EVENT,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
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

  const receipt = await ref.bridge.sendGroupMessage(groupId, elements);
  const messageId = hashMessageIdInt32(receipt.sequence, groupId, GROUP_MESSAGE_EVENT);

  logSentMessage(true, groupId, elements);

  ref.cacheMessageMeta(messageId, {
    isGroup: true,
    targetId: groupId,
    sequence: receipt.sequence,
    eventName: GROUP_MESSAGE_EVENT,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
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
  const nodes = await parseForwardNodes(ref, messages);
  const forwardId = await ref.bridge.uploadForwardNodes(nodes, groupId);
  const previewElement = buildForwardPreviewElement(forwardId, nodes, true, meta);
  const receipt = await ref.bridge.sendGroupMessage(groupId, [previewElement]);
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

  return { messageId, forwardId };
}

export async function sendPrivateForwardMessage(
  ref: OneBotInstanceContext,
  userId: number,
  messages: JsonValue,
  meta?: ForwardPreviewMeta,
): Promise<{ messageId: number; forwardId: string }> {
  const nodes = await parseForwardNodes(ref, messages);
  const forwardId = await ref.bridge.uploadForwardNodes(nodes);
  const previewElement = buildForwardPreviewElement(forwardId, nodes, false, meta);
  const receipt = await ref.bridge.sendPrivateMessage(userId, [previewElement]);
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

  return { messageId, forwardId };
}

export async function uploadForwardMessage(
  ref: OneBotInstanceContext,
  messages: JsonValue,
): Promise<{ forwardId: string }> {
  const nodes = await parseForwardNodes(ref, messages);
  const forwardId = await ref.bridge.uploadForwardNodes(nodes);
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
    receipt = await ref.bridge.sendGroupMessage(target.groupId, elements);
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
  } else {
    receipt = await ref.bridge.sendPrivateMessage(target.userId!, elements);
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
  const nodes = await ref.bridge.fetchForwardNodes(resId);
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
      default:
        break;
    }
  }

  const content = parts.join(' ').trim() || '[空消息]';
  log.info(`${type} ${targetId} | 发送：${content}`);
}

async function parseForwardNodes(
  ref: OneBotInstanceContext,
  messages: JsonValue,
): Promise<ForwardNodePayload[]> {
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
    const elements = await parseMessage(content, false);
    if (elements.length === 0) throw new Error(`forward node content is empty: ${userUin}`);

    nodes.push({ userUin, nickname, elements });
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
