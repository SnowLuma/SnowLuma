// Forward-message upload / download via the long-message service.
// Uses gzipped protobufs over `trpc.group.long_msg_interface`.
// An in-memory cache keeps res_ids stable across rapid re-fetches
// from the same OneBot client (avoids re-decoding the same payload).

import type { Bridge } from '../bridge';
import { gunzipSync, gzipSync } from 'zlib';
import { protoDecode, protoEncode } from '../../protobuf/decode';
import { buildSendElems } from '../element-builder';
import { parseMsgPush } from '../msg-push';
import type { ForwardNodePayload } from '../events';
import type { PacketInfo } from '../../protocol/types';
import {
  LongMsgResultSchema,
  RecvLongMsgReqSchema,
  RecvLongMsgRespSchema,
  SendLongMsgReqSchema,
  SendLongMsgRespSchema,
} from '../proto/longmsg';
import { PushMsgSchema } from '../proto/message';
import { resolveSelfUid, toInt } from './shared';

// Module-scoped cache, keyed by res_id. Survives only for the lifetime
// of the process — that's enough because OneBot clients typically
// resolve a forward immediately after receiving the parent message.
const forwardResCache = new Map<string, ForwardNodePayload[]>();

async function buildForwardPushBody(
  bridge: Bridge,
  node: ForwardNodePayload,
  groupId?: number,
  userUid?: string,
): Promise<Record<string, unknown>> {
  const fromUin = node.userUin > 0 ? node.userUin : toInt(bridge.identity.uin);
  if (fromUin <= 0) throw new Error('forward node user uin is invalid');

  const nickname = node.nickname.trim() || String(fromUin);
  // image/record/video upload inside a forward node must be scoped to the
  // forward's recipient: group → groupId, private → recipient uid.
  // Without this the OIDB upload (0x11c4/0x11c5) has no scene and the
  // element builder throws "private image target uid is missing".
  const sendCtx = groupId !== undefined
    ? { bridge, groupId }
    : userUid
      ? { bridge, userUid }
      : { bridge };
  const elems = await buildSendElems(node.elements, sendCtx);
  const now = Math.floor(Date.now() / 1000);
  const random = Math.floor(Math.random() * 0x7fffffff) >>> 0;
  const seq = Math.floor(Math.random() * 9000000) + 1000000;

  return {
    responseHead: {
      fromUin,
      toUid: bridge.identity.selfUid ?? '',
      forward: {
        friendName: nickname,
      },
    },
    contentHead: {
      msgType: 9,
      subType: 4,
      msgId: random,
      sequence: seq,
      timestamp: now,
      divSeq: 0,
    },
    body: {
      richText: {
        elems,
      },
    },
  };
}

export async function uploadForwardNodes(
  bridge: Bridge,
  nodes: ForwardNodePayload[],
  groupId?: number,
  userId?: number,
): Promise<string> {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('forward nodes are required');
  }

  // For a private forward to `userId`, any image/record/video inside a node
  // needs the recipient's uid as upload scene. Resolve it once up-front,
  // and only when at least one node actually contains media (saves an RPC
  // for text-only forwards).
  let userUid: string | undefined;
  if (groupId === undefined && userId !== undefined && userId > 0) {
    const hasMedia = nodes.some(node => node.elements.some(
      e => e.type === 'image' || e.type === 'record' || e.type === 'video',
    ));
    if (hasMedia) {
      const resolved = await bridge.resolveUserUid(userId);
      if (resolved) userUid = resolved;
    }
  }

  const msgBody = await Promise.all(nodes.map(node => buildForwardPushBody(bridge, node, groupId, userUid)));
  const longMsgResult = protoEncode({
    action: [
      {
        actionCommand: 'MultiMsg',
        actionData: { msgBody: msgBody as any },
      },
    ],
  }, LongMsgResultSchema);

  const selfUid = await resolveSelfUid(bridge);
  const info: any = {
    type: groupId ? 3 : 1,
    uid: { uid: groupId ? String(groupId) : selfUid },
    payload: gzipSync(Buffer.from(longMsgResult)),
  };
  if (groupId) info.groupUin = groupId;

  const request = protoEncode({
    info,
    settings: {
      field1: 4,
      field2: 1,
      field3: 7,
      field4: 0,
    },
  }, SendLongMsgReqSchema);

  const result = await bridge.sendRawPacket('trpc.group.long_msg_interface.MsgService.SsoSendLongMsg', request);
  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'upload forward message failed');
  }

  const resp = protoDecode(result.responseData, SendLongMsgRespSchema);
  const resId = typeof resp?.result?.resId === 'string' ? resp.result.resId : '';
  if (!resId) {
    throw new Error('upload forward message response missing res_id');
  }

  forwardResCache.set(resId, nodes.map(node => ({
    userUin: node.userUin,
    nickname: node.nickname,
    elements: [...node.elements],
    time: node.time,
    msgId: node.msgId,
    msgSeq: node.msgSeq,
    groupId: node.groupId ?? groupId,
    senderCard: node.senderCard,
    messageType: node.messageType ?? (groupId ? 'group' : 'private'),
  })));

  return resId;
}

export async function fetchForwardNodes(bridge: Bridge, resId: string): Promise<ForwardNodePayload[]> {
  const cached = forwardResCache.get(resId);
  if (cached) {
    return cached.map(node => ({
      userUin: node.userUin,
      nickname: node.nickname,
      elements: [...node.elements],
      time: node.time,
      msgId: node.msgId,
      msgSeq: node.msgSeq,
      groupId: node.groupId,
      senderCard: node.senderCard,
      messageType: node.messageType,
    }));
  }

  const selfUid = await resolveSelfUid(bridge);
  const request = protoEncode({
    info: {
      uid: { uid: selfUid },
      resId,
      acquire: true,
    },
    settings: {
      field1: 2,
      field2: 0,
      field3: 0,
      field4: 0,
    },
  }, RecvLongMsgReqSchema);

  const result = await bridge.sendRawPacket('trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg', request);
  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'download forward message failed');
  }

  const resp = protoDecode(result.responseData, RecvLongMsgRespSchema);
  const payload = resp?.result?.payload;
  if (!(payload instanceof Uint8Array) || payload.length === 0) {
    throw new Error('download forward message payload is empty');
  }

  const inflate = gunzipSync(Buffer.from(payload));
  const longMsg = protoDecode(inflate, LongMsgResultSchema);
  const action = longMsg?.action?.find((item: any) => item?.actionCommand === 'MultiMsg');
  const msgBodyList = Array.isArray(action?.actionData?.msgBody) ? action.actionData.msgBody : [];

  const nodes: ForwardNodePayload[] = [];
  for (const msgBody of msgBodyList) {
    const wrapped = protoEncode({ message: msgBody }, PushMsgSchema);
    const pkt: PacketInfo = {
      pid: 0,
      uin: bridge.identity.uin,
      serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
      seqId: 0,
      retCode: 0,
      fromClient: false,
      body: wrapped,
    };
    const events = parseMsgPush(pkt, bridge.identity);
    const event = events.find(e =>
      e.kind === 'friend_message' || e.kind === 'group_message' || e.kind === 'temp_message');
    if (!event) continue;

    if (event.kind === 'group_message') {
      nodes.push({
        userUin: event.senderUin,
        nickname: event.senderCard || event.senderNick,
        elements: event.elements,
        time: event.time,
        msgId: event.msgId,
        msgSeq: event.msgSeq,
        groupId: event.groupId,
        senderCard: event.senderCard,
        messageType: 'group',
      });
    } else if (event.kind === 'friend_message') {
      nodes.push({
        userUin: event.senderUin,
        nickname: event.senderNick,
        elements: event.elements,
        time: event.time,
        msgId: event.msgId,
        msgSeq: event.msgSeq,
        messageType: 'private',
      });
    } else {
      nodes.push({
        userUin: event.senderUin,
        nickname: event.senderNick,
        elements: event.elements,
        time: event.time,
        msgSeq: event.msgSeq,
        groupId: event.groupId,
        messageType: 'private',
      });
    }
  }

  if (nodes.length > 0) {
    forwardResCache.set(resId, nodes.map(node => ({
      userUin: node.userUin,
      nickname: node.nickname,
      elements: [...node.elements],
      time: node.time,
      msgId: node.msgId,
      msgSeq: node.msgSeq,
      groupId: node.groupId,
      senderCard: node.senderCard,
      messageType: node.messageType,
    })));
  }
  return nodes;
}
