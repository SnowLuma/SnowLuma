import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { ForwardNodePayload, FriendMessage, GroupMessage, MessageElement, MessageElementOf, QQEventVariant } from '@snowluma/protocol/events';
import { getVideoSourceSize, MAX_VIDEO_SIZE } from '@snowluma/protocol/highway/video-upload';
import type { MessageSendResult } from '../api-handler';
import { convertEvent, elementsToOneBotSegments, type ConverterContext } from '../event-converter';
import { segmentsToRawMessage } from '../helper/cq';
import type { OneBotInstanceContext } from '../instance-context';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from '../message-id';
import { MessageElementValidationError, parseMessage } from '../message-parser';
import type { MessageStore } from '../message-store';
import { sameSelfSentMessage } from '../self-sent-event';
import { hasAuthoritativeSequence, type JsonArray, type JsonObject, type JsonValue, type MessageMeta } from '../types';

const log = createLogger('OneBot');

// A video larger than QQ's Highway video ceiling can't be sent through the
// element pipeline — it must fall back to a regular file upload. The fallback
// is decided at the OneBot layer (not element-builder) because building a
// group/c2c file element needs an uploaded file, which only the file-upload
// pipeline produces. See send-video-fallback.test.ts.

/** Whether a Highway upload error message looks size-related. */
export function isHighwaySizeError(err: unknown): boolean {
  return err instanceof Error && /size limit|too large|413|too big|exceed/i.test(err.message);
}

/**
 * A video element should fall back to file upload when its source size is
 * known to exceed the limit, or — when the size can't be inferred (remote
 * URL) — when the upload error itself looks size-related.
 */
export function videoNeedsFileFallback(element: MessageElement, isSizeErr: boolean): boolean {
  if (element.type !== 'video') return false;
  const sz = getVideoSourceSize(element);
  return sz !== null ? sz > MAX_VIDEO_SIZE : isSizeErr;
}

/**
 * Partition elements after a failed Highway send: oversized videos become
 * `file` elements (re-routed through the file-upload pipeline), everything
 * else is returned for a normal re-send.
 */
export function splitVideoFileFallback(
  elements: Array<Exclude<MessageElement, { type: 'file' }>>,
  isSizeErr: boolean,
): {
  fileEls: Array<MessageElementOf<'file'>>;
  remaining: Array<Exclude<MessageElement, { type: 'file' }>>;
} {
  const fileEls: Array<MessageElementOf<'file'>> = [];
  const remaining: Array<Exclude<MessageElement, { type: 'file' }>> = [];
  for (const e of elements) {
    if (videoNeedsFileFallback(e, isSizeErr)) {
      const fileElement: MessageElementOf<'file'> = {
        type: 'file',
        url: e.url,
        fileId: e.fileId,
        fileName: e.fileName || 'video.mp4',
        fileSize: e.fileSize,
        fileHash: e.fileHash,
        md5Hex: e.md5Hex,
        sha1Hex: e.sha1Hex,
      };
      if (!fileElement.url && !fileElement.fileId) {
        throw new MessageElementValidationError(
          'MISSING_FIELD',
          'oversized video fallback requires a file/url source; a fingerprint alone cannot enter the file upload pipeline',
          'video',
          'url',
        );
      }
      fileEls.push(fileElement);
    } else {
      remaining.push(e);
    }
  }
  return { fileEls, remaining };
}

export async function getGroupMsgHistory(
  messageStore: MessageStore,
  groupId: number,
  messageId?: number,
  count?: number,
  reverseOrder = true,
): Promise<JsonObject[]> {
  if (!Number.isInteger(groupId) || groupId <= 0) return [];
  const limit = normalizeHistoryCount(count);
  const hasAnchor = Number.isInteger(messageId) && messageId !== 0;

  let anchorSequence: number | undefined;
  if (hasAnchor) {
    const meta = messageStore.findMeta(messageId as number);
    if (!hasAuthoritativeSequence(meta) || !meta.isGroup || meta.targetId !== groupId) return [];
    anchorSequence = meta.sequence;
  }

  const events = messageStore.listSessionEvents(true, groupId, limit, anchorSequence, reverseOrder);
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
  reverseOrder = true,
): Promise<JsonObject[]> {
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const limit = normalizeHistoryCount(count);
  const hasAnchor = Number.isInteger(messageId) && messageId !== 0;

  let anchorSequence: number | undefined;
  if (hasAnchor) {
    const meta = messageStore.findMeta(messageId as number);
    if (!hasAuthoritativeSequence(meta) || meta.isGroup || meta.targetId !== userId) return [];
    anchorSequence = meta.sequence;
  }

  const events = messageStore.listSessionEvents(false, userId, limit, anchorSequence, reverseOrder);
  return events
    // `session_id` is the conversation peer. Self-sent messages legitimately
    // carry the bot's own `user_id`, so filtering by sender would drop them.
    .filter((event) => event.message_type === 'private')
    .map(sanitizeMessageEventForApi);
}

// Deps the server-backed history fetch needs from the instance context.
interface HistoryRef {
  bridge: BridgeInterface;
  messageStore: MessageStore;
  converterCtx: ConverterContext;
  selfId: number;
}

/**
 * Group history, fetched from the server (`SsoGetGroupMsg`) instead of only the
 * local observed-message store — so it can return messages SnowLuma never saw
 * live, and (because each fetched message is persisted) reply / get_msg on old
 * messages start working too. Resolves the anchor sequence from the requested
 * message_id (or the latest observed message), then asks the bridge for the
 * requested number of older or newer messages including that anchor. Falls
 * back to the local store if the server fetch is unavailable or empty.
 */
export async function getGroupHistory(
  ref: HistoryRef,
  groupId: number,
  messageId: number | undefined,
  count: number | undefined,
  reverseOrder = true,
): Promise<JsonObject[]> {
  if (!Number.isInteger(groupId) || groupId <= 0) return [];
  const want = normalizeHistoryCount(count);
  const hasAnchor = Number.isInteger(messageId) && messageId !== 0;
  const effectiveReverseOrder = hasAnchor ? reverseOrder : true;

  let anchorSeq = 0;
  if (hasAnchor) {
    const meta = ref.messageStore.findMeta(messageId as number);
    if (!hasAuthoritativeSequence(meta) || !meta.isGroup || meta.targetId !== groupId) {
      // Anchor we don't know — best effort from the local store.
      return getGroupMsgHistory(ref.messageStore, groupId, messageId, count, reverseOrder);
    }
    anchorSeq = meta.sequence;
  } else {
    anchorSeq = ref.messageStore.findLatestAuthoritativeSequence(true, groupId) ?? 0;
  }
  log.debug(
    'group history anchor selected: group=%d source=%s anchorSeq=%d',
    groupId,
    hasAnchor ? 'message_id' : 'latest_authoritative',
    anchorSeq,
  );

  if (anchorSeq > 0) {
    try {
      const events = await ref.bridge.apis.message.getGroupHistory(
        groupId,
        anchorSeq,
        want,
        ref.selfId,
        effectiveReverseOrder,
      );
      const out: JsonObject[] = [];
      for (const ev of events) {
        const json = await convertEvent(ref.converterCtx, ev);
        if (!json || json.message_type !== 'group') continue;
        persistHistoryEvent(ref.messageStore, json); // full event → reply/get_msg + future listing
        out.push(sanitizeMessageEventForApi(json));   // sanitized for the API (matches the local path)
      }
      if (out.length > 0) return out;
      log.debug(
        'group history server fetch returned no usable messages: group=%d anchorSeq=%d count=%d; using local store',
        groupId,
        anchorSeq,
        want,
      );
    } catch (err) {
      log.warn(
        'group history server fetch failed: group=%d anchorSeq=%d count=%d reverseOrder=%s error=%s; using local store',
        groupId,
        anchorSeq,
        want,
        String(effectiveReverseOrder),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return getGroupMsgHistory(ref.messageStore, groupId, messageId, count, reverseOrder);
}

/**
 * Private (c2c) history — the same server-fetch + persist pattern as
 * {@link getGroupHistory}, but via `SsoGetC2cMsg` (peer = the friend's UID,
 * resolved from the uin). The anchor is the message_id's sequence (any side of
 * the conversation) or the latest observed inbound message. Direction applies
 * only to an explicit anchor; an unanchored request keeps latest-page behavior.
 * Falls back to the local store on unknown anchor / no uid / empty / error.
 */
export async function getFriendHistory(
  ref: HistoryRef,
  userId: number,
  messageId: number | undefined,
  count: number | undefined,
  reverseOrder = true,
): Promise<JsonObject[]> {
  if (!Number.isInteger(userId) || userId <= 0) return [];
  const want = normalizeHistoryCount(count);
  const hasAnchor = Number.isInteger(messageId) && messageId !== 0;
  const effectiveReverseOrder = hasAnchor ? reverseOrder : true;

  let anchorSeq = 0;
  if (hasAnchor) {
    const meta = ref.messageStore.findMeta(messageId as number);
    // Older self-sent rows may be keyed by selfId. Only accept one of those
    // when its stored target_id proves that it belongs to this peer; otherwise
    // a message_id from another private conversation could select the wrong
    // server sequence.
    const storedEvent = meta?.targetId === ref.selfId
      ? ref.messageStore.findEvent(messageId as number)
      : null;
    const belongsToPeer = meta?.targetId === userId
      || (meta?.targetId === ref.selfId && toHistInt(storedEvent?.target_id) === userId);
    if (!hasAuthoritativeSequence(meta) || meta.isGroup || !belongsToPeer) {
      return getFriendMsgHistory(ref.messageStore, userId, messageId, count, reverseOrder);
    }
    anchorSeq = meta.sequence;
  } else {
    // Current rows are keyed by conversation peer, so the latest local anchor
    // covers both incoming and self-sent messages. Legacy sender-keyed rows are
    // repaired when they are fetched through an explicit anchor.
    anchorSeq = ref.messageStore.findLatestAuthoritativeSequence(false, userId) ?? 0;
  }
  log.debug(
    'friend history anchor selected: user=%d source=%s anchorSeq=%d',
    userId,
    hasAnchor ? 'message_id' : 'latest_authoritative',
    anchorSeq,
  );

  if (anchorSeq > 0) {
    try {
      const friendUid = await ref.bridge.resolveUserUid(userId);
      if (friendUid) {
        const events = await ref.bridge.apis.message.getC2cHistory(
          friendUid,
          anchorSeq,
          want,
          ref.selfId,
          effectiveReverseOrder,
        );
        const out: JsonObject[] = [];
        for (const ev of events) {
          // The action itself identifies the conversation even when an older
          // QQ response omits ResponseHead.toUin on a self-sent row.
          if (!ev.peerUin || ev.peerUin <= 0) ev.peerUin = userId;
          const json = await convertEvent(ref.converterCtx, ev);
          if (!json || json.message_type !== 'private') continue;
          // Private history is scoped by the requested peer, while user_id is
          // the sender and therefore equals selfId for outgoing messages.
          // Preserve the peer explicitly so later local pagination can keep
          // both sides of the conversation together.
          if (json.post_type === 'message_sent' && toHistInt(json.target_id) === 0) {
            json.target_id = userId;
          }
          persistHistoryEvent(ref.messageStore, json, userId);
          out.push(sanitizeMessageEventForApi(json));
        }
        if (out.length > 0) return out;
        log.debug(
          'friend history server fetch returned no usable messages: user=%d anchorSeq=%d count=%d; using local store',
          userId,
          anchorSeq,
          want,
        );
      }
    } catch (err) {
      log.warn(
        'friend history server fetch failed: user=%d anchorSeq=%d count=%d reverseOrder=%s error=%s; using local store',
        userId,
        anchorSeq,
        want,
        String(effectiveReverseOrder),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return getFriendMsgHistory(ref.messageStore, userId, messageId, count, reverseOrder);
}

/**
 * Back-fill the message a freshly-received reply points to, when the local store
 * doesn't have the full event (e.g. a message from before SnowLuma was running,
 * or one it never observed). Fetches just the quoted message from the server —
 * group via `SsoGetGroupMsg`, c2c via `SsoGetC2cMsg`, both through the shared
 * history throttle gate — and persists it under the SAME id the reply resolves
 * to, so a subsequent `get_msg` (or quote lookup) hits.
 *
 * No-op when: the event isn't a group/friend message, has no reply, the target
 * is already stored, the uid can't be resolved, the fetch returns nothing, or
 * it errors. Meant to be awaited before dispatch so the consumer's get_msg —
 * which an approval bot fires right after seeing the reply — sees the message.
 */
export async function backfillReplyTarget(ref: HistoryRef, event: QQEventVariant): Promise<void> {
  let isGroup: boolean;
  let session: number;
  if (event.kind === 'group_message') { isGroup = true; session = event.groupId; }
  else if (event.kind === 'friend_message') {
    isGroup = false;
    session = event.peerUin ?? event.senderUin;
  }
  else return;
  if (!Number.isInteger(session) || session <= 0) return;

  const reply = event.elements.find(
    (e: MessageElement) => e.type === 'reply' && Number.isInteger(e.replySeq) && (e.replySeq ?? 0) > 0,
  );
  const replySeq = reply?.replySeq ?? 0;
  if (replySeq <= 0) return;

  const eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;
  const targetId = hashMessageIdInt32(replySeq, session, eventName);
  if (ref.messageStore.findEvent(targetId)) return; // Tier 0: already have the full event

  // Tier 1: fetch the quoted message from the server, keyed under the exact id
  // the reply resolves to (replySeq is origSeqs[0] == the quoted message's own
  // head.sequence, so this matches how it was/would be stored). A c2c message
  // the bot itself sent converts with user_id=self but is still keyed under the
  // reply's session (the peer), so get_msg(targetId) hits.
  try {
    let fetched: GroupMessage | FriendMessage | null = null;
    if (isGroup) {
      fetched = await ref.bridge.apis.message.getGroupMessageBySeq(session, replySeq, ref.selfId);
    } else {
      const friendUid = await ref.bridge.resolveUserUid(session);
      if (friendUid) {
        fetched = await ref.bridge.apis.message.getC2cMessageBySeq(friendUid, replySeq, ref.selfId);
      }
    }
    if (fetched) {
      const json = await convertEvent(ref.converterCtx, fetched);
      if (json) {
        json.message_id = targetId;
        ref.messageStore.storeEvent(targetId, isGroup, session, replySeq, eventName, json);
        return;
      }
    }
  } catch (err) {
    log.warn('reply-target backfill tier-1 failed (%s)', err instanceof Error ? err.message : String(err));
  }

  // Tier 2: reconstruct from the quoted message's own elements, which the push
  // embeds in SrcMsg.elems — no server round-trip. Covers messages the server
  // won't return (expired, self-c2c, file-only) but whose content rode along.
  const quotedSender = reply?.replySenderUin ?? (isGroup ? 0 : session);
  if (reply?.replyElements?.length) {
    try {
      const segments = await elementsToOneBotSegments(
        reply.replyElements, isGroup, session,
        ref.converterCtx.imageUrlResolver, ref.converterCtx.mediaUrlResolver,
        ref.converterCtx.messageIdResolver, ref.converterCtx.mediaSegmentSink,
      ) as JsonArray;
      const fallback = buildBackfillEvent(targetId, replySeq, quotedSender,
        reply.replyTime ?? 0, segments, ref.selfId, isGroup, session);
      // Inline quote metadata proves what was displayed, but not that replySeq
      // still names a server-backed roam message. Keep it queryable via
      // get_msg without letting it become a history/recall/reply anchor.
      ref.messageStore.storeEvent(
        targetId,
        isGroup,
        session,
        replySeq,
        eventName,
        fallback,
        { sequenceAuthoritative: false },
      );
      return;
    } catch (err) {
      log.warn('reply-target backfill tier-2 failed (%s)', err instanceof Error ? err.message : String(err));
    }
  }

  // Tier 3: minimal `[引用消息]` placeholder so get_msg(reply_id) never returns
  // "message not found" — an approval bot that fires get_msg right after seeing
  // the reply gets a well-formed (if sparse) event instead of an error.
  const placeholder = buildBackfillEvent(targetId, replySeq, quotedSender,
    reply?.replyTime ?? 0, [{ type: 'text', data: { text: '[引用消息]' } }],
    ref.selfId, isGroup, session);
  ref.messageStore.storeEvent(
    targetId,
    isGroup,
    session,
    replySeq,
    eventName,
    placeholder,
    { sequenceAuthoritative: false },
  );
}

// Build a stored-message event for a backfilled reply target (Tier 2/3).
function buildBackfillEvent(
  messageId: number,
  msgSeq: number,
  senderUin: number,
  timestamp: number,
  segments: JsonArray,
  selfId: number,
  isGroup: boolean,
  sessionId: number,
): JsonObject {
  const common = {
    time: timestamp || Math.floor(Date.now() / 1000),
    self_id: selfId,
    post_type: 'message' as const,
    message_id: messageId,
    message_seq: msgSeq,
    message: segments,
    raw_message: segmentsToRawMessage(segments),
    font: 0,
  };
  if (isGroup) {
    return {
      ...common,
      message_type: 'group',
      sub_type: 'normal',
      group_id: sessionId,
      user_id: senderUin,
      sender: { user_id: senderUin, nickname: '', card: '', role: 'member', sex: 'unknown', age: 0 },
      anonymous: null,
    };
  }
  return {
    ...common,
    message_type: 'private',
    sub_type: 'friend',
    user_id: senderUin,
    sender: { user_id: senderUin, nickname: '', sex: 'unknown', age: 0 },
  };
}

// Persist a converted history event so reply / get_msg / future listing resolve
// it. Private history callers provide the conversation peer because `user_id`
// identifies the sender and equals the bot account on outgoing messages.
function persistHistoryEvent(store: MessageStore, event: JsonObject, privatePeerId?: number): void {
  const messageId = toHistInt(event.message_id);
  if (messageId === 0) return;
  const isGroup = event.message_type === 'group';
  const sessionId = isGroup
    ? toHistInt(event.group_id)
    : (privatePeerId && privatePeerId > 0 ? privatePeerId : toHistInt(event.user_id));
  const sequence = toHistInt(event.message_seq);
  const eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;
  if (sessionId === 0) return;
  store.storeEvent(messageId, isGroup, sessionId, sequence, eventName, event);
}

function toHistInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return 0;
}

export async function deleteMessage(bridge: BridgeInterface, meta: MessageMeta): Promise<void> {
  if (!hasAuthoritativeSequence(meta)) {
    throw new Error('message has no authoritative QQ sequence and cannot be recalled');
  }
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
  if (!hasAuthoritativeSequence(meta)) {
    throw new Error('message has no authoritative QQ sequence and cannot be marked as essence');
  }
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
/**
 * The shared "record a self-sent message" tail: derive the OneBot message id
 * from (sequence, target, event), then cache both the meta and the self-sent
 * copy. Centralizes the `isGroup ↔ eventName ↔ hashMessageIdInt32 event
 * constant` coupling that was hand-paired in six send/forward paths — a
 * mismatch there silently produced a wrong message_id or wrong event
 * attribution. Returns the derived message id and, for an eligible plain C2C
 * Action send, an event for the OneBot dispatch path when QQ has not already
 * supplied the canonical echo.
 */
async function finalizeSend(
  ref: OneBotInstanceContext,
  isGroup: boolean,
  targetId: number,
  receipt: {
    messageId?: number;
    sequence: number;
    clientSequence: number;
    random: number;
    timestamp: number;
  },
  elements: MessageElement[],
  reportEcho = false,
): Promise<MessageSendResult> {
  const eventName = isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT;
  const sequenceAuthoritative = Number.isInteger(receipt.sequence) && receipt.sequence > 0;
  const opaqueMessageId = receipt.messageId ?? 0;
  // Ordinary sends use QQ's real sequence so receive/send paths derive the same
  // OneBot id. OIDB-only sends (notably group files) have no QQ sequence: keep
  // their opaque local id separate instead of feeding a file hash into protocol
  // operations as if it were a server sequence (#254).
  const messageId = sequenceAuthoritative
    ? hashMessageIdInt32(receipt.sequence, targetId, eventName)
    : Number.isInteger(opaqueMessageId) && opaqueMessageId !== 0
      ? opaqueMessageId
      : hashMessageIdInt32(0, targetId, eventName);
  ref.cacheMessageMeta(messageId, {
    isGroup,
    targetId,
    sequence: receipt.sequence,
    sequenceAuthoritative,
    eventName,
    clientSequence: receipt.clientSequence,
    random: receipt.random,
    timestamp: receipt.timestamp,
  });
  const echoEvent = await cacheSelfSentMessage(ref, {
    isGroup,
    sessionId: targetId,
    messageId,
    sequence: receipt.sequence,
    sequenceAuthoritative,
    timestamp: receipt.timestamp,
    elements,
  });
  return reportEcho && echoEvent && sequenceAuthoritative && receipt.timestamp > 0
    ? { messageId, echoEvent }
    : { messageId };
}

async function cacheSelfSentMessage(
  ref: OneBotInstanceContext,
  options: {
    isGroup: boolean;
    sessionId: number;       // groupId or peer userId
    messageId: number;
    sequence: number;
    sequenceAuthoritative: boolean;
    timestamp: number;
    elements: MessageElement[];
  },
): Promise<JsonObject | null> {
  const {
    isGroup,
    sessionId,
    messageId,
    sequence,
    sequenceAuthoritative,
    timestamp,
    elements,
  } = options;
  if (!Number.isInteger(messageId) || messageId === 0) return null;

  // Defensive: tests may mock `ref.messageStore` without the full MessageStore
  // surface. Production always has it. Without storage, recall still works via
  // cacheMessageMeta, but `/get_msg` and the synthetic event are unavailable.
  const storeEvent = (ref.messageStore as { storeEvent?: typeof ref.messageStore.storeEvent }).storeEvent;
  if (typeof storeEvent !== 'function') return null;

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
        // This is the bot itself — seed our own nickname so a self-sent message
        // that the server never echoes back (notably group file / video sends,
        // which publish via OIDB rather than PbSendMsg) doesn't surface an empty
        // sender.nickname in get_msg / get_group_msg_history. For a normal text
        // send the echo still overwrites this with the same value.
        nickname: ref.bridge.identity.nickname || '',
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

    // QQ can win the race between the send receipt and local event
    // construction. Keep its richer canonical event and let the already-run
    // bridge dispatch remain the single downstream notification.
    const existing = ref.messageStore.findEvent(messageId);
    if (existing && sameSelfSentMessage(existing, event)) return null;

    // Persist before dispatch so `/get_msg` is immediately consistent for a
    // client reacting to the synthetic message_sent notification.
    storeEvent.call(
      ref.messageStore,
      messageId,
      isGroup,
      sessionId,
      sequence,
      eventName,
      event,
      { sequenceAuthoritative },
    );
    return event;
  } catch (err) {
    // Never turn a successful QQ send into a failed Action after the fact.
    // The warning keeps the loss observable; `/get_msg` and the optional
    // synthetic event degrade together while recall still uses cached meta.
    log.warn('[OneBot] failed to cache self-sent message %d: %s',
      messageId, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function resolveContactArk(ref: OneBotInstanceContext, contactType: string, contactId: number): Promise<string> | null {
  const normalized = contactType.trim().toLowerCase();
  if (normalized === 'qq') return ref.bridge.apis.contacts.getBuddyRecommendArk(contactId, '');
  if (normalized === 'group') return ref.bridge.apis.contacts.getGroupRecommendArk(contactId);
  return null;
}

export async function sendPrivateMessage(
  ref: OneBotInstanceContext,
  userId: number,
  message: JsonValue,
  autoEscape: boolean,
  /** When set, reply into this group's temp session instead of friend c2c. */
  tempGroupId?: number,
): Promise<MessageSendResult> {
  // A temp-session reply is only allowed into a session the peer opened.
  const isTempReply = tempGroupId !== undefined && ref.tempSessions.has(userId, tempGroupId);
  if (tempGroupId !== undefined && !isTempReply) {
    throw new Error(`cannot send to user ${userId} in group ${tempGroupId}: no such temp session`);
  }
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
          sequenceAuthoritative: meta?.sequenceAuthoritative,
        };
      }
      const meta = ref.messageStore.findMeta(replyMessageId);
      if (meta) {
        return {
          senderUin: ref.selfId,
          time: meta.timestamp,
          random: meta.random,
          sequenceAuthoritative: meta.sequenceAuthoritative,
        };
      }
      return null;
    },
    resolveMentionUid: (targetUin) => ref.bridge.resolveUserUid(targetUin),
    resolveContactArk: (contactType, contactId) => resolveContactArk(ref, contactType, contactId),
    musicSignUrl: ref.musicSignUrl,
  });
  if (elements.length === 0) throw new Error('message is empty');

  // Private chats cannot @-mention anyone. Reject the whole request rather
  // than deleting the at and sending a different message than the caller gave.
  const hasAt = elements.some(e => e.type === 'at');
  if (hasAt) {
    throw new MessageElementValidationError(
      'UNSENDABLE_TYPE',
      'message element "at" cannot be sent in a private chat',
      'at',
    );
  }

  // Temp sessions only have the message-element transport. File elements use
  // the friend c2c upload path, so reject them before sending any preceding
  // text/media batch; discovering this after sendText would create a partial
  // send followed by a failed Action response.
  if (tempGroupId !== undefined) {
    const unsupported = elements.find((element) =>
      element.type === 'file' || videoNeedsFileFallback(element, false));
    if (unsupported) {
      throw new MessageElementValidationError(
        'UNSENDABLE_TYPE',
        `message element "${unsupported.type}" cannot be sent in a temp session`,
        unsupported.type,
      );
    }
  }

  // C2C `{type:'file'}` segments can't ride on the elems[] pipeline —
  // c2c files live on `RichText.notOnlineFile`, parallel to elems
  // (see `@snowluma/proto-defs/message:notOnlineFile`). The element-builder
  // rejects them as a routing error. Split them before invoking the element
  // builder so they enter the dedicated c2c-file pipeline.
  //
  // NapCat splits the same way (`dev/NapCatQQ/.../SendMsg.ts:404-415`):
  // FILE / VIDEO / ARK / PTT each go in their own sendMsg call,
  // never mixed with the regular elements. We only need it for file
  // here — video/ARK/ptt already go through commonElem so the
  // element-builder handles them inline.
  // Two sub-paths:
  //  a) has url/path but no file_id → uploadPrivate() which internally calls sendC2cFile()
  //  b) has file_id from a prior upload_private_file → sendC2cFile() only
  let allFileElements = elements.filter(e => e.type === 'file');
  let nonFileElements = elements.filter(e => e.type !== 'file');
  let fileTargetUid: string | null = null;
  const ensureFileTargetUid = async (): Promise<string> => {
    if (fileTargetUid) return fileTargetUid;
    const resolved = await ref.bridge.resolveUserUid(userId);
    if (!resolved) throw new Error(`c2c file send: could not resolve uid for user ${userId}`);
    fileTargetUid = resolved;
    return resolved;
  };

  // [#145] Videos up to MAX_VIDEO_SIZE (1.5 GiB) send as real videos; only
  // above that do we route to the file pipeline (the whole video is buffered
  // in RAM for the Highway upload, so this bounds memory). The earlier
  // 100 MB cap was a workaround for the width/height=0 → 已过期 bug (now
  // fixed) and has been lifted. Route known-oversized videos up front —
  // the on-error fallback below can't catch them (the upload doesn't throw).
  {
    const pre = splitVideoFileFallback(nonFileElements, false);
    if (pre.fileEls.length > 0) {
      allFileElements = [...allFileElements, ...pre.fileEls];
      nonFileElements = pre.remaining;
    }
  }

  // Resolve every deterministic prerequisite for the dedicated file path
  // before sending a preceding text/media batch. Otherwise a mixed
  // `[text, file]` request could publish the text and only then discover that
  // the recipient UID required by RichText.notOnlineFile is unavailable.
  if (allFileElements.length > 0) await ensureFileTargetUid();

  // Route text/media batches through the temp-session primitive when replying
  // passively, else the normal friend c2c path.
  const sendText = (elems: MessageElement[]) =>
    isTempReply && tempGroupId !== undefined
      ? ref.bridge.apis.message.sendGroupTempMessage(userId, tempGroupId, elems)
      : ref.bridge.apis.message.sendPrivate(userId, elems);

  let lastReceipt: Awaited<ReturnType<typeof ref.bridge.apis.message.sendPrivate>> | undefined;
  if (nonFileElements.length > 0) {
    try {
      lastReceipt = await sendText(nonFileElements);
      logSentMessage(false, userId, nonFileElements);
    } catch (err) {
      // A temp-session reply can't fall back to the c2c file path (friend-only)
      // — surface the original error rather than mis-routing.
      if (tempGroupId !== undefined) throw err;
      // Highway upload failed — if a large video triggered it, fall back to
      // file upload for that element (private messages cannot carry file
      // elements through the element pipeline).
      const isSizeErr = isHighwaySizeError(err);
      if (!nonFileElements.some(e => videoNeedsFileFallback(e, isSizeErr))) throw err;
      log.warn('[OneBot] private video upload failed, falling back to file upload: %s', err instanceof Error ? err.message : String(err));
      const { fileEls, remaining } = splitVideoFileFallback(nonFileElements, isSizeErr);
      allFileElements = [...allFileElements, ...fileEls];
      nonFileElements = remaining;
      if (fileEls.length > 0) await ensureFileTargetUid();
      if (nonFileElements.length > 0) {
        lastReceipt = await ref.bridge.apis.message.sendPrivate(userId, nonFileElements);
        logSentMessage(false, userId, nonFileElements);
      }
    }
  }
  if (allFileElements.length > 0) {
    if (tempGroupId !== undefined) {
      throw new Error('temp-session file preflight invariant failed');
    }
    const userUid = await ensureFileTargetUid();
    for (const fileEl of allFileElements) {
      if (fileEl.url && !fileEl.fileId) {
        // uploadPrivate() already calls sendC2cFile() internally — do NOT call it again.
        const name = fileEl.fileName || fileEl.url.split('/').pop() || 'file';
        await ref.bridge.apis.groupFile.uploadPrivate(userId, fileEl.url, name, true);
        logSentMessage(false, userId, [fileEl]);
        if (!lastReceipt) {
          lastReceipt = { messageId: 0, sequence: 0, clientSequence: 0, random: 0, timestamp: Math.floor(Date.now() / 1000) };
        }
      } else if (fileEl.fileId) {
        const cached = ref.bridge.recallUploadedFile(fileEl.fileId);
        const fileMd5 = fileEl.md5Hex ? Buffer.from(fileEl.md5Hex, 'hex') : (cached?.fileMd5 ?? new Uint8Array(0));
        const fileSize = fileEl.fileSize ?? cached?.fileSize ?? 0;
        const fileName = fileEl.fileName ?? cached?.fileName ?? 'file';
        const fileHash = fileEl.fileHash ?? cached?.fileHash;
        lastReceipt = await ref.bridge.apis.message.sendC2cFile(userId, userUid, { fileId: fileEl.fileId, fileName, fileSize, fileMd5, fileHash });
        logSentMessage(false, userId, [fileEl]);
      } else {
        throw new MessageElementValidationError(
          'MISSING_FIELD',
          'private file segment requires file_id or url',
          'file',
        );
      }
    }
  }
  if (!lastReceipt) throw new Error('message is empty');

  // Dedicated C2C file sends may split one Action into several QQ messages.
  // A single synthetic event would misrepresent that wire behaviour, so only
  // report the one-batch friend path handled by sendPrivate().
  const reportEcho = tempGroupId === undefined && allFileElements.length === 0;
  return finalizeSend(ref, false, userId, lastReceipt, elements, reportEcho);
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
      const meta = ref.messageStore.findMeta(replyMessageId);
      if (!meta || !meta.isGroup || meta.targetId !== groupId) return null;
      const event = ref.messageStore.findEvent(replyMessageId);
      if (event) {
        return {
          senderUin: typeof event.user_id === 'number'
            ? event.user_id
            : parseInt(String(event.user_id || '0'), 10),
          time: typeof event.time === 'number'
            ? event.time
            : parseInt(String(event.time || '0'), 10),
          random: meta?.random ?? 0,
          sequenceAuthoritative: meta?.sequenceAuthoritative,
        };
      }
      return {
        senderUin: ref.selfId,
        time: meta.timestamp,
        random: meta.random,
        sequenceAuthoritative: meta.sequenceAuthoritative,
      };
    },
    resolveMentionUid: (targetUin) => ref.bridge.resolveUserUid(targetUin, groupId),
    resolveContactArk: (contactType, contactId) => resolveContactArk(ref, contactType, contactId),
    musicSignUrl: ref.musicSignUrl,
  });
  if (elements.length === 0) throw new Error('message is empty');

  // Two sub-paths for group file segments:
  //  a) has url/path but no file_id → upload() which internally calls publish()
  //  b) has file_id from a prior upload_group_file → publish() only
  let allFileElements = elements.filter(e => e.type === 'file');
  let nonFileElements = elements.filter(e => e.type !== 'file');

  // [#145] Route videos above MAX_VIDEO_SIZE (1.5 GiB) to the file path up
  // front; everything at or below sends as a real video (see sendPrivate).
  {
    const pre = splitVideoFileFallback(nonFileElements, false);
    if (pre.fileEls.length > 0) {
      allFileElements = [...allFileElements, ...pre.fileEls];
      nonFileElements = pre.remaining;
    }
  }

  let lastReceipt: Awaited<ReturnType<typeof ref.bridge.apis.message.sendGroup>> | undefined;
  if (nonFileElements.length > 0) {
    try {
      lastReceipt = await ref.bridge.apis.message.sendGroup(groupId, nonFileElements);
      logSentMessage(true, groupId, nonFileElements);
    } catch (err) {
      // Highway upload failed — if a large video triggered it, fall back to
      // group file upload (mirrors the private path; element-builder cannot
      // build a group file element without an already-uploaded file_id).
      const isSizeErr = isHighwaySizeError(err);
      if (!nonFileElements.some(e => videoNeedsFileFallback(e, isSizeErr))) throw err;
      log.warn('[OneBot] group video upload failed, falling back to file upload: %s', err instanceof Error ? err.message : String(err));
      const { fileEls, remaining } = splitVideoFileFallback(nonFileElements, isSizeErr);
      allFileElements = [...allFileElements, ...fileEls];
      nonFileElements = remaining;
      if (nonFileElements.length > 0) {
        lastReceipt = await ref.bridge.apis.message.sendGroup(groupId, nonFileElements);
        logSentMessage(true, groupId, nonFileElements);
      }
    }
  }
  for (const fileEl of allFileElements) {
    let fileId: string;
    if (fileEl.url && !fileEl.fileId) {
      // upload() already calls publish() internally — do NOT call publish() again.
      const name = fileEl.fileName || fileEl.url.split('/').pop() || 'file';
      const result = await ref.bridge.apis.groupFile.upload(groupId, fileEl.url, name, '/', true);
      fileId = result.fileId ?? '';
      if (!fileId) throw new Error('group file auto-upload returned no file_id');
    } else if (fileEl.fileId) {
      fileId = fileEl.fileId;
      await ref.bridge.apis.groupFile.publish(groupId, fileId);
    } else {
      throw new MessageElementValidationError(
        'MISSING_FIELD',
        'group file segment requires file_id or url',
        'file',
      );
      continue;
    }
    logSentMessage(true, groupId, [fileEl]);
    if (!lastReceipt) {
      let h = 0;
      for (let i = 0; i < fileId.length; i++) h = ((h << 5) - h + fileId.charCodeAt(i)) | 0;
      const localSeed = h & 0x7FFFFFFF;
      lastReceipt = {
        messageId: hashMessageIdInt32(localSeed, groupId, GROUP_MESSAGE_EVENT),
        sequence: 0,
        clientSequence: 0,
        random: localSeed,
        timestamp: Math.floor(Date.now() / 1000),
      };
    }
  }
  if (!lastReceipt) throw new Error('message is empty');

  return finalizeSend(ref, true, groupId, lastReceipt, elements);
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
  const { messageId } = await finalizeSend(ref, true, groupId, receipt, [previewElement]);

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
  const { messageId } = await finalizeSend(ref, false, userId, receipt, [previewElement]);

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
    ({ messageId: messageIdOut } = await finalizeSend(ref, true, target.groupId, receipt, elements));
  } else {
    receipt = await ref.bridge.apis.message.sendPrivate(target.userId!, elements);
    ({ messageId: messageIdOut } = await finalizeSend(ref, false, target.userId!, receipt, elements));
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
    // Route forward nodes through the SAME resolver-equipped conversion the
    // normal receive path uses (to-message.ts). Without the image/media URL
    // resolvers the segments come back with raw, rkey-less download URLs —
    // exactly issue #74 (`/get_forward_msg` image url 缺少 rkey). Image rkey
    // re-signing is scene-aware via the appid in the URL (see instance-rkey).
    const segments = await elementsToOneBotSegments(
      node.elements, isGroup, sessionId,
      ref.converterCtx.imageUrlResolver,
      ref.converterCtx.mediaUrlResolver,
    );

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
 * Mixed content (some nodes + some text/image) returns false: that's not a
 * meaningful nested-forward shape, so the regular strict parser rejects the
 * embedded node before any upload starts.
 */
function isNestedNodeArray(value: JsonValue): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const item of value) {
    const seg = asJsonObject(item);
    if (!seg || String(seg.type ?? '') !== 'node') return false;
  }
  return true;
}

function assertForwardNodeMetadataIsScalar(
  nodeData: JsonObject,
  index: number,
): void {
  for (const [field, value] of Object.entries(nodeData)) {
    if (field === 'content' || field === 'message') continue;
    if (
      value === undefined || value === null || typeof value === 'string'
      || typeof value === 'number' || typeof value === 'boolean'
    ) continue;
    throw new MessageElementValidationError(
      'INVALID_FIELD',
      `forward messages[${index}].${field} must be a scalar value`,
      'node',
      field,
    );
  }
}

async function parseForwardNodes(
  ref: OneBotInstanceContext,
  messages: JsonValue,
  options: ParseForwardOptions = {},
): Promise<ForwardNodePayload[]> {
  const depth = options.depth ?? 0;
  if (depth >= MAX_FORWARD_DEPTH) {
    throw new MessageElementValidationError(
      'INVALID_FIELD',
      `forward nesting depth exceeds ${MAX_FORWARD_DEPTH}`,
      'node',
      'content',
    );
  }

  if (!Array.isArray(messages)) {
    throw new MessageElementValidationError(
      'INVALID_FIELD',
      'forward messages must be an array of node segments',
      'node',
      'messages',
    );
  }
  if (messages.length === 0) {
    throw new MessageElementValidationError(
      'MISSING_FIELD',
      'forward messages must contain at least one node',
      'node',
      'messages',
    );
  }

  // Validate the entire top-level node list before parsing any content. The
  // old loop silently continued past malformed/unknown entries, so a forward
  // Action could upload the remaining nodes and report success with altered
  // caller intent.
  const prepared = messages.map((item, index) => {
    const segment = asJsonObject(item);
    if (!segment) {
      throw new MessageElementValidationError(
        'INVALID_FIELD',
        `forward messages[${index}] must be an object`,
        'node',
        `messages[${index}]`,
      );
    }
    const rawType = segment.type;
    if (rawType !== undefined && typeof rawType !== 'string') {
      throw new MessageElementValidationError(
        'INVALID_FIELD',
        `forward messages[${index}].type must be "node"`,
        'node',
        'type',
      );
    }
    if (typeof rawType === 'string' && rawType !== 'node') {
      throw new MessageElementValidationError(
        'UNKNOWN_TYPE',
        `unknown forward message segment type: ${rawType}`,
        rawType,
        'type',
      );
    }

    if (rawType === 'node') {
      const nodeData = asJsonObject(segment.data);
      if (!nodeData) {
        throw new MessageElementValidationError(
          'INVALID_FIELD',
          `forward messages[${index}].data must be an object`,
          'node',
          'data',
        );
      }
      assertForwardNodeMetadataIsScalar(nodeData, index);
      return { segment, nodeData };
    }

    // Preserve the existing bare-node compatibility form, but require it to
    // carry content explicitly instead of silently ignoring arbitrary objects.
    if (segment.content === undefined && segment.message === undefined) {
      throw new MessageElementValidationError(
        'MISSING_FIELD',
        `forward messages[${index}] requires type:"node" data or bare content/message`,
        'node',
        'content',
      );
    }
    assertForwardNodeMetadataIsScalar(segment, index);
    return { segment, nodeData: segment };
  });

  const nodes: ForwardNodePayload[] = [];
  for (const { nodeData } of prepared) {

    const messageId = parseForwardMessageId(nodeData.id ?? nodeData.message_id);
    if (messageId !== 0) {
      const event = ref.messageStore.findEvent(messageId);
      if (!event) {
        throw new MessageElementValidationError(
          'INVALID_FIELD',
          `forward node message_id not found: ${String(messageId)}`,
          'node',
          'message_id',
        );
      }

      const eventSender = asJsonObject(event.sender) ?? {};
      const senderCard = eventSender.card !== undefined ? String(eventSender.card) : undefined;
      const nickname = String(eventSender.card ?? eventSender.nickname ?? nodeData.nickname ?? nodeData.name ?? '');
      const userUin = toPositiveInt(event.user_id);
      if (userUin <= 0) {
        throw new MessageElementValidationError(
          'INVALID_FIELD',
          `forward node message_id ${String(messageId)} has no valid sender user_id`,
          'node',
          'user_id',
        );
      }
      const content = (event.message ?? event.raw_message ?? '') as JsonValue;
      const elements = await parseMessage(content, false);
      if (elements.length > 0) {
        const messageType = event.message_type === 'group' ? 'group' : 'private';
        const groupIdValue = toPositiveInt(event.group_id);
        nodes.push({
          userUin,
          nickname: nickname || String(userUin),
          elements,
          time: typeof event.time === 'number' ? event.time : toPositiveInt(event.time),
          msgId: toSafeSignedInteger(event.message_id),
          msgSeq: toPositiveInt(event.message_seq),
          groupId: groupIdValue > 0 ? groupIdValue : undefined,
          senderCard,
          messageType,
        });
      }
      continue;
    }

    // [#203] A fake forward node may omit user_id or send "0" — upstream
    // frameworks (AstrBot, etc.) don't manage QQ uins. The protocol端 is logged
    // in and the core builder already defaults a zero sender to the bot's own
    // uin (bridge/apis/forward.ts buildForwardPushBody), so match that leniency
    // here instead of rejecting. The throw stays as a guard for the not-logged-in
    // case (selfId 0).
    const userUin = toPositiveInt(nodeData.user_id ?? nodeData.uin) || ref.selfId;
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
    // Honour an explicit per-node display time (OneBot `data.time`, unix
    // seconds) so a custom forward can set/back-date each node's timestamp
    // (#209). The wire field is uint32, so reject a millisecond value or any
    // out-of-range input (it would overflow/throw) and fall back to now.
    const nodeTime = toPositiveInt(nodeData.time);
    if (nodeTime > 0 && nodeTime < 0xffffffff) node.time = nodeTime;
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

function toSafeSignedInteger(value: JsonValue | undefined): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 0;
}

function parseForwardMessageId(value: JsonValue | undefined): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new MessageElementValidationError(
    'INVALID_FIELD',
    'forward node id/message_id must be a non-zero safe integer',
    'node',
    'message_id',
  );
}
