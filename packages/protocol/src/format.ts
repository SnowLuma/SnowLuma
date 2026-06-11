import type { QQEventVariant } from './events';
import type { IdentityService } from './identity-service';
import type { JsonObject, JsonValue } from '@snowluma/common/json';

/**
 * Minimal shape of the OneBot-side `MessageStore` that `formatReply`
 * needs — just `findEvent(id)`. Defined inline (instead of importing
 * the full `MessageStore` class from @snowluma/onebot) so this
 * package doesn't depend on the OneBot layer above it. The OneBot
 * `MessageStore` is structurally a superset of this interface, so
 * callers pass it through with zero adaptation.
 */
export interface ReplyEventLookup {
  findEvent(messageId: number): JsonObject | null;
}

const MAX_TEXT_PREVIEW = 50;
const MAX_REPLY_BODY_PREVIEW = 30;

/** "[群名(12345)]" if known, else "12345" (or "0" if missing). */
export function formatGroup(identity: IdentityService, groupId: number): string {
  if (!groupId || groupId <= 0) return String(groupId || 0);
  try {
    const g = identity.findGroup(groupId);
    const name = g?.groupName?.trim();
    return name ? `[${name}(${groupId})]` : String(groupId);
  } catch {
    return String(groupId);
  }
}

/**
 * "[card-or-nick(uin)]" when the uin is in the group-member or friend
 * roster; falls back to the bare uin string. When only a uid is known
 * (no uin yet) the uid is returned as-is so the line still references
 * someone — better than logging "0".
 */
export function formatUser(
  identity: IdentityService,
  groupId: number | undefined,
  uin: number,
  uid?: string,
): string {
  try {
    if (!uin || uin <= 0) return uid ? uid : '0';
    if (groupId !== undefined && groupId > 0) {
      const member = identity.findGroupMember(groupId, uin);
      const name = member?.card?.trim() || member?.nickname?.trim();
      if (name) return `[${name}(${uin})]`;
    }
    const friend = identity.findFriend(uin);
    const fname = friend?.remark?.trim() || friend?.nickname?.trim();
    if (fname) return `[${fname}(${uin})]`;
    return String(uin);
  } catch {
    return String(uin);
  }
}

/**
 * One-line preview of an OneBot-shape message (array of segments or
 * raw string). Element rendering matches the existing logReceivedMessage
 * vocabulary so this is a drop-in replacement, with a few additions
 * (json / xml / markdown / forward / poke / file).
 */
export function formatMessageSegments(message: JsonValue): string {
  try {
    if (typeof message === 'string') {
      return truncate(message, MAX_TEXT_PREVIEW) || '[空消息]';
    }
    if (!Array.isArray(message)) return '[空消息]';
    const parts: string[] = [];
    for (const seg of message) {
      if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) continue;
      const obj = seg as JsonObject;
      const type = String(obj.type ?? '');
      const data = (typeof obj.data === 'object' && obj.data !== null && !Array.isArray(obj.data))
        ? obj.data as Record<string, unknown>
        : {};
      parts.push(renderSegment(type, data));
    }
    return parts.join(' ').trim() || '[空消息]';
  } catch {
    return '[消息渲染异常]';
  }
}

function renderSegment(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case 'text': return truncate(String(data.text ?? ''), MAX_TEXT_PREVIEW);
    case 'image': return '[图片]';
    case 'face': return '[表情]';
    case 'mface': return data.text ? `[${String(data.text)}]` : '[表情]';
    case 'at': return data.qq === 'all' ? '@全体成员' : `@${data.qq ?? ''}`;
    case 'reply': return `[回复:${data.id ?? ''}]`;
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': {
      // OneBot file segments carry the filename under `data.name`
      // (see to-segment.ts). Keep `data.file` as a fallback for any
      // upstream that still uses the older field name.
      const fileName = data.name ?? data.file;
      return fileName ? `[文件:${truncate(String(fileName), 20)}]` : '[文件]';
    }
    case 'json': return '[JSON]';
    case 'xml': return '[XML]';
    case 'markdown': return '[Markdown]';
    case 'forward': return '[聊天记录]';
    case 'poke': return '[戳一戳]';
    default: return `[${type}]`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Resolve a `reply` segment's referenced message and return a short
 * "[回复 user: body...]" string. On miss (older than store retention,
 * never seen, lookup throws) falls back to "[回复:<id>]" so the chain
 * reference is at least preserved.
 *
 * Deliberately one level deep — we don't recurse into the reply's own
 * reply. Long chains aren't worth the runtime cost in the hot path,
 * and a 1-level peek catches 90% of real-world "what's this referring
 * to" questions.
 */
export function formatReply(
  messageStore: ReplyEventLookup,
  identity: IdentityService,
  replyId: number,
): string {
  try {
    if (!replyId) return '[回复:0]';
    const event = messageStore.findEvent(replyId);
    if (!event) return `[回复:${replyId}]`;
    const isGroup = event.message_type === 'group';
    const uin = toIntOrZero(event.user_id);
    const groupId = isGroup ? toIntOrZero(event.group_id) : undefined;

    // Prefer cache; if cache miss, use the sender fields baked into the
    // stored event itself (those came from the original receive path
    // when the roster was warm).
    let userPart = formatUser(identity, groupId, uin);
    if (userPart === String(uin) && uin > 0) {
      const sender = (typeof event.sender === 'object' && event.sender !== null && !Array.isArray(event.sender))
        ? event.sender as JsonObject
        : {};
      const fallback = ((sender.card as string) || (sender.nickname as string) || '').trim();
      if (fallback) userPart = `[${fallback}(${uin})]`;
    }

    const body = truncate(formatMessageSegments(event.message as JsonValue), MAX_REPLY_BODY_PREVIEW);
    return `[回复 ${userPart}: ${body}]`;
  } catch {
    return `[回复:${replyId}]`;
  }
}

function toIntOrZero(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Readable one-line rendering of a notice-class QQEventVariant. Returns
 * null for kinds the OneBot layer's message log already renders
 * (group_message / friend_message / temp_message / group_file_upload /
 * friend_add — those have richer dedicated paths).
 */
export function formatEvent(identity: IdentityService, event: QQEventVariant): string | null {
  try {
    switch (event.kind) {
      case 'group_message':
      case 'friend_message':
      case 'temp_message':
      case 'group_file_upload':
      case 'friend_add':
        return null;
      case 'group_recall':
        return `群撤回 ${formatGroup(identity, event.groupId)} | ${formatUser(identity, event.groupId, event.authorUin)} 被 ${formatUser(identity, event.groupId, event.operatorUin)} 撤回`;
      case 'friend_recall':
        return `私聊撤回 ${formatUser(identity, undefined, event.userUin)} 撤回了消息`;
      case 'group_member_join':
        return `入群 ${formatUser(identity, event.groupId, event.userUin, event.userUid)} 加入 ${formatGroup(identity, event.groupId)}`;
      case 'group_member_leave': {
        const leaveAction = event.leaveType === 'disband' ? '随群解散' : event.leaveType === 'kick' ? '被踢出' : '退出';
        return `退群 ${formatUser(identity, event.groupId, event.userUin, event.userUid)} ${leaveAction} ${formatGroup(identity, event.groupId)}`;
      }
      case 'group_mute':
        return `禁言 ${formatGroup(identity, event.groupId)} | ${formatUser(identity, event.groupId, event.userUin)} ${event.duration}秒`;
      case 'group_admin':
        return `管理 ${formatGroup(identity, event.groupId)} | ${formatUser(identity, event.groupId, event.userUin)} ${event.set ? '+' : '-'}管理员`;
      case 'friend_poke':
        return `戳一戳 ${formatUser(identity, undefined, event.userUin)} -> ${formatUser(identity, undefined, event.targetUin)}`;
      case 'group_poke':
        return `群戳 ${formatGroup(identity, event.groupId)} | ${formatUser(identity, event.groupId, event.userUin)} -> ${formatUser(identity, event.groupId, event.targetUin)}`;
      case 'friend_request':
        return `好友请求 ${formatUser(identity, undefined, event.fromUin)}: ${event.message}`;
      case 'group_invite':
        return `群邀请 ${formatUser(identity, undefined, event.fromUin)} -> ${formatGroup(identity, event.groupId)}`;
      case 'group_essence':
        return `精华 ${formatGroup(identity, event.groupId)} | ${event.set ? '+' : '-'}精华`;
      case 'group_msg_emoji_like':
        return `表情回应 ${formatGroup(identity, event.groupId)} | ${formatUser(identity, event.groupId, event.operatorUin, event.operatorUid)} ${event.isAdd ? '+' : '-'}[${event.emojiId}] msgSeq=${event.msgSeq}`;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
