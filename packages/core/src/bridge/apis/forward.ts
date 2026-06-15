import type { PacketInfo } from '@snowluma/common/protocol-types';
import type {
  LongMsgResult,
  RecvLongMsgReq,
  RecvLongMsgResp,
  SendLongMsgReq,
  SendLongMsgResp,
} from '@snowluma/proto-defs/longmsg';
import type { FileExtra, PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import type { ForwardNodePayload, MessageElement } from '@snowluma/protocol/events';
import { parseMsgPush } from '@snowluma/protocol/msg-push';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { randomUUID } from 'crypto';
import { gunzipSync, gzipSync } from 'zlib';
import type { Bridge } from '../bridge';
import type { BridgeContext } from '../bridge-context';
import { resolveSelfUid, toInt } from './shared';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

// Module-scoped cache, keyed by res_id. Survives only for the lifetime
// of the process — that's enough because OneBot clients typically
// resolve a forward immediately after receiving the parent message.
const forwardResCache = new Map<string, ForwardNodePayload[]>();

// Per-layer piggyback entry. Each level of a nested forward attaches
// its own msgBody under a uuid `actionCommand`, so when the receiver
// fetches the outermost res_id it gets every layer in one shot
// (modelled on NapCat's `uploadForwardedNodesPacket` — see
// `dev/NapCatQQ/.../SendMsg.ts:208-347`). Lagrange.Core master + V2
// both ship a single-action model and silently break when the
// recipient is a NapCat instance trying to walk the tree.
interface ForwardInnerAction {
  uuid: string;
  msgBody: PushMsgBody[];
}

interface ForwardUploadResult {
  resId: string;
  // The current level's msgBody + uuid — what an outer caller would
  // piggyback to expose this layer through the tree.
  msgBody: PushMsgBody[];
  uuid: string;
  // All accumulated piggyback entries from deeper levels. Outer
  // callers concatenate these to their own actions list so the
  // outermost upload carries the full tree.
  innerActions: ForwardInnerAction[];
}

// Local hex-decode helper — avoids importing the heavyweight `pipeline`
// module just for one call. Mirrors `highway/pipeline.ts::hexToBytes`.
function hexToBytesLocal(hex: string): Uint8Array {
  const s = hex.trim();
  if (!s) return new Uint8Array(0);
  const len = s.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

async function buildForwardPushBody(
  bridge: Bridge,
  node: ForwardNodePayload,
  groupId?: number,
  userUid?: string,
): Promise<PushMsgBody> {
  const fromUin = node.userUin > 0 ? node.userUin : toInt(bridge.identity.uin);
  if (fromUin <= 0) throw new Error('forward node user uin is invalid');

  const nickname = node.nickname.trim() || String(fromUin);
  // image/record/video upload inside a forward node must be scoped to the
  // forward's recipient: group → groupId, private → recipient uid.
  // Without this the OIDB upload (0x11c4/0x11c5) has no scene and the
  // element builder throws "private image target uid is missing".
  //
  // `forwardFake: true` keeps `{type:'file'}` segments in the
  // long-msg payload: group → emitted as transElem(24) in elems[],
  // c2c → handled below via msgContent (FileExtra { file: NotOnlineFile }).
  // The QQ-NT live-send pipeline would reject these (transElem(24) →
  // result=79; notOnlineFile via PbSendMsg doesn't render), but the
  // long-msg upload service stores the bytes verbatim and the
  // receiver decodes them through the normal msg-push path.
  const sendCtx = groupId !== undefined
    ? { bridge, groupId, forwardFake: true }
    : userUid
      ? { bridge, userUid, forwardFake: true }
      : { bridge, forwardFake: true };
  const elems = await buildSendElems(node.elements, sendCtx);
  const now = Math.floor(Date.now() / 1000);
  const random = Math.floor(Math.random() * 0x7fffffff) >>> 0;
  const seq = Math.floor(Math.random() * 9000000) + 1000000;

  // c2c-file in a forward node — element-builder intentionally skips
  // it (RichText.notOnlineFile + msgContent live outside elems[]). For
  // forward fake-send we mirror what an inbound c2c file message looks
  // like on the wire: serialise the FileExtra blob and ride it on
  // `body.msgContent`. The receiver's rich-body-decoder reads from
  // `msgContent` first (see msg-push/rich-body-decoder.ts:446+), so
  // the bubble renders with the right file name + size when the
  // forward is expanded. Only the FIRST c2c file in a node ships —
  // QQ NT's bubble can only carry one msgContent payload, same as
  // a live c2c send. Group nodes ignore this branch entirely (the
  // transElem(24) elems[] entry above covers them).
  let msgContent: Uint8Array | undefined;
  if (groupId === undefined) {
    const fileEl = node.elements.find(e => e.type === 'file' && e.fileId);
    if (fileEl) {
      // Honour inline segment fields first; fall back to the upload
      // metadata cache (populated by upload_private_file). Without
      // size/md5 the receiver would render "0 B" so prefer recovering
      // them — see same logic in modules/message-actions.ts.
      const cached = bridge.recallUploadedFile(fileEl.fileId ?? '');
      const fileMd5 = fileEl.md5Hex
        ? hexToBytesLocal(fileEl.md5Hex)
        : (cached?.fileMd5 ?? new Uint8Array(0));
      const fileSize = fileEl.fileSize ?? cached?.fileSize ?? 0;
      const fileName = fileEl.fileName ?? cached?.fileName ?? 'file';
      const fileHash = fileEl.fileHash ?? cached?.fileHash ?? '';
      const sevenDays = 7 * 24 * 60 * 60;
      msgContent = protobuf_encode<FileExtra>({
        file: {
          fileType: 0,
          fileUuid: fileEl.fileId!,
          fileMd5,
          fileName,
          fileSize: BigInt(fileSize),
          subcmd: 1,
          dangerEvel: 0,
          expireTime: now + sevenDays,
          fileHash,
        },
      });
    }
  }

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
      c2cCmd: 0,
    },
    body: {
      richText: {
        elems,
      },
      ...(msgContent ? { msgContent } : {}),
    },
  };
}

// Inner forward preview metadata — kept minimal here (the OneBot
// `parseForwardNodes` caller can override these on the top-level
// node by passing custom forwardSource/forwardSummary on the
// non-nested send path; nested levels just get sensible defaults
// since they're synthesised by us and never reach OneBot input).
function deriveInnerSource(innerNodes: ForwardNodePayload[], isGroup: boolean): string {
  const nicks: string[] = [];
  const seen = new Set<string>();
  for (const node of innerNodes) {
    const name = (node.nickname ?? '').trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      nicks.push(name);
    }
    if (nicks.length >= 4) break;
  }
  if (nicks.length === 0) return isGroup ? '群聊的聊天记录' : '聊天记录';
  return `${nicks.join('和')}的聊天记录`;
}

function previewLinesFromNodes(innerNodes: ForwardNodePayload[]): Array<{ text: string }> {
  return innerNodes.slice(0, 4).map(node => {
    const name = (node.nickname ?? '').trim() || String(node.userUin || 'QQ用户');
    const previewText = previewFromElements(node.elements);
    return { text: previewText ? `${name}: ${previewText}` : name };
  });
}

function previewFromElements(elements: MessageElement[]): string {
  for (const elem of elements) {
    if (elem.type === 'text' && elem.text) return elem.text.slice(0, 30);
    if (elem.type === 'image') return '[图片]';
    if (elem.type === 'record') return '[语音]';
    if (elem.type === 'video') return '[视频]';
    if (elem.type === 'file') return '[文件]';
    if (elem.type === 'forward') return '[聊天记录]';
    if (elem.type === 'face') return '[表情]';
  }
  return '';
}

export class ForwardApi {
  constructor(private readonly ctx: BridgeContext) { }

  async upload(nodes: ForwardNodePayload[], groupId?: number, userId?: number): Promise<string> {
    const { resId } = await this.uploadRecursive(nodes, groupId, userId);
    return resId;
  }

  /**
   * Recursive upload with NapCat-style piggyback. Each invocation:
   *   1. Walks `nodes`. For any node whose `innerForward` is set,
   *      recursively uploads that inner chain first (which itself runs
   *      this same recursion).
   *   2. Replaces the node's `elements` with an ARK preview pointing at
   *      the inner res_id (and inner uuid for receiver-side walking).
   *   3. Accumulates the inner level's `{uuid, msgBody}` plus all of
   *      ITS accumulated `innerActions` into this level's piggyback list.
   *   4. Encodes this level's long-msg payload as
   *      `[MultiMsg + thisMsgBody, ...innerActions]`, uploads it,
   *      returns `{resId, msgBody, uuid, innerActions}` so an outer
   *      caller can keep piggybacking up the tree.
   */
  private async uploadRecursive(
    nodes: ForwardNodePayload[],
    groupId?: number,
    userId?: number,
  ): Promise<ForwardUploadResult> {
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new Error('forward nodes are required');
    }

    const bridge = asBridge(this.ctx);

    // For a private forward to `userId`, any image/record/video inside a node
    // needs the recipient's uid as upload scene. Resolve it once up-front,
    // and only when at least one node actually contains media (saves an RPC
    // for text-only forwards). Also need it when a node is itself a nested
    // forward — the inner upload uses the same scene.
    let userUid: string | undefined;
    if (groupId === undefined && userId !== undefined && userId > 0) {
      const needsUid = nodes.some(node => !!node.innerForward
        || node.elements.some(e => e.type === 'image' || e.type === 'record' || e.type === 'video'));
      if (needsUid) {
        const resolved = await this.ctx.resolveUserUid(userId);
        if (resolved) userUid = resolved;
      }
    }

    // Walk nodes and resolve nested forwards first (so we know their
    // res_id / uuid before encoding the outer ARK previews). Build
    // `processedNodes` with elements rewritten for nested layers,
    // and collect every inner level's piggyback in `myInnerActions`.
    //
    // CRITICAL: the same uuid (`inner.uuid`) MUST be baked into the
    // outer's preview element as `forwardUuid` AND used as the
    // `actionCommand` for the outer's piggyback entry. That's the
    // alignment the QQ-NT receiver uses to find the inner layer
    // inside the outer's LongMsgResult without a second server fetch
    // — see `dev/NapCatQQ/.../SendMsg.ts:241-246` + the `uniseq` round-
    // trip in `dev/NapCatQQ/.../forward-msg-builder.ts:94`.
    const myInnerActions: ForwardInnerAction[] = [];
    const processedNodes: ForwardNodePayload[] = [];
    const isGroup = groupId !== undefined;
    for (const node of nodes) {
      if (node.innerForward && node.innerForward.length > 0) {
        const inner = await this.uploadRecursive(node.innerForward, groupId, userId);
        // NapCat piggybacks `{uuid: inner.uuid, packetMsg: inner.packetMsg}`
        // + the entire `inner.innerPacketMsg` array up to its caller. We
        // mirror that — `inner.uuid` indexes the inner level itself,
        // and `inner.innerActions` already contains deeper layers.
        myInnerActions.push({ uuid: inner.uuid, msgBody: inner.msgBody });
        myInnerActions.push(...inner.innerActions);
        // Replace the inner placeholder element with a forward preview
        // pointing at the inner res_id. `forwardUuid: inner.uuid`
        // baked into the LightApp JSON's `meta.detail.uniseq` is what
        // closes the loop with our piggyback action above.
        const previewElement: MessageElement = {
          type: 'forward',
          resId: inner.resId,
          forwardUuid: inner.uuid,
          forwardSource: deriveInnerSource(node.innerForward, isGroup),
          forwardSummary: `查看${node.innerForward.length}条转发消息`,
          forwardPrompt: '[聊天记录]',
          forwardNews: previewLinesFromNodes(node.innerForward),
          forwardTSum: node.innerForward.length,
        };
        processedNodes.push({
          userUin: node.userUin,
          nickname: node.nickname,
          elements: [previewElement],
          time: node.time,
          msgId: node.msgId,
          msgSeq: node.msgSeq,
          groupId: node.groupId,
          senderCard: node.senderCard,
          messageType: node.messageType,
        });
      } else {
        processedNodes.push(node);
      }
    }

    // Encode this level's msgBody.
    const msgBody = await Promise.all(processedNodes.map(
      node => buildForwardPushBody(bridge, node, groupId, userUid),
    ));

    // Compose the action list: own MultiMsg + piggybacked inner actions.
    const longMsgResult = protobuf_encode<LongMsgResult>({
      action: [
        { actionCommand: 'MultiMsg', actionData: { msgBody } },
        ...myInnerActions.map(a => ({
          actionCommand: a.uuid,
          actionData: { msgBody: a.msgBody },
        })),
      ],
    });

    const selfUid = await resolveSelfUid(bridge);
    const info: SendLongMsgReq['info'] = {
      type: groupId ? 3 : 1,
      uid: { uid: groupId ? String(groupId) : selfUid },
      payload: gzipSync(Buffer.from(longMsgResult)),
    };
    if (groupId) info.groupUin = groupId;

    const request = protobuf_encode<SendLongMsgReq>({
      info,
      settings: {
        field1: 4,
        field2: 1,
        field3: 7,
        field4: 0,
      },
    });

    const result = await this.ctx.sendRawPacket('trpc.group.long_msg_interface.MsgService.SsoSendLongMsg', request);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(result.errorMessage || 'upload forward message failed');
    }

    const resp = protobuf_decode<SendLongMsgResp>(result.responseData);
    const resId = typeof resp?.result?.resId === 'string' ? resp.result.resId : '';
    if (!resId) {
      throw new Error('upload forward message response missing res_id');
    }

    forwardResCache.set(resId, processedNodes.map(node => ({
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

    return {
      resId,
      msgBody,
      // UUID generated here so the OUTER caller can use it as both
      // (1) the `actionCommand` for its piggyback entry carrying our
      //     msgBody, and
      // (2) the `forwardUuid` baked into its forward-preview element
      //     pointing at our resId.
      // Receivers walking the outer's LongMsgResult find the inner
      // layer by matching `uniseq` from (2) against `actionCommand`
      // from (1) — no separate fetch needed.
      uuid: randomUUID(),
      innerActions: myInnerActions,
    };
  }

  async fetch(resId: string): Promise<ForwardNodePayload[]> {
    const bridge = asBridge(this.ctx);
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
    const request = protobuf_encode<RecvLongMsgReq>({
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
    });

    const result = await this.ctx.sendRawPacket('trpc.group.long_msg_interface.MsgService.SsoRecvLongMsg', request);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(result.errorMessage || 'download forward message failed');
    }

    const resp = protobuf_decode<RecvLongMsgResp>(result.responseData);
    const payload = resp?.result?.payload;
    if (!(payload instanceof Uint8Array) || payload.length === 0) {
      throw new Error('download forward message payload is empty');
    }

    const inflate = gunzipSync(Buffer.from(payload));
    const longMsg = protobuf_decode<LongMsgResult>(inflate);
    const actions = Array.isArray(longMsg?.action) ? longMsg!.action! : [];
    const mainAction = actions.find(item => item?.actionCommand === 'MultiMsg');
    const msgBodyList = Array.isArray(mainAction?.actionData?.msgBody) ? mainAction!.actionData!.msgBody : [];

    // Piggyback index: any non-`MultiMsg` action carries an inner
    // layer keyed by the uuid the sender baked into its forward
    // preview's `uniseq`. Build a lookup so we can resolve inner
    // forwards (via their uniseq → inner msgBody) without a second
    // server roundtrip — matches the sender-side piggyback emitted in
    // `uploadRecursive` above.
    const piggybackByUuid = new Map<string, PushMsgBody[]>();
    for (const action of actions) {
      const cmd = action?.actionCommand;
      if (!cmd || cmd === 'MultiMsg') continue;
      const body = Array.isArray(action.actionData?.msgBody) ? action.actionData.msgBody : [];
      piggybackByUuid.set(cmd, body);
    }

    const nodes = this.decodeMsgBodiesToNodes(msgBodyList);

    // Walk the decoded outer nodes for inner-forward previews
    // (`type: 'forward', forwardUuid: <uniseq>`). For each, pull the
    // matching piggyback body, decode it into inner nodes, and seed
    // the cache by the inner resId so a follow-up `fetch(innerResId)`
    // hits the cache instead of the wire.
    if (piggybackByUuid.size > 0) {
      this.consumePiggybacks(nodes, piggybackByUuid);
    }

    if (nodes.length > 0) {
      forwardResCache.set(resId, cloneNodes(nodes));
    }
    return nodes;
  }

  /** Walk a list of PushMsgBody, run each through the regular msg-push
   *  pipeline, and shape the result into ForwardNodePayloads. Extracted
   *  so both the outer + piggyback decode paths share one implementation. */
  private decodeMsgBodiesToNodes(msgBodyList: PushMsgBody[]): ForwardNodePayload[] {
    const out: ForwardNodePayload[] = [];
    for (const msgBody of msgBodyList) {
      const wrapped = protobuf_encode<PushMsg>({ message: msgBody });
      const pkt: PacketInfo = {
        pid: 0,
        uin: this.ctx.identity.uin,
        serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
        seqId: 0,
        retCode: 0,
        fromClient: false,
        body: wrapped,
      };
      const events = parseMsgPush(pkt, this.ctx.identity);
      const event = events.find(e =>
        e.kind === 'friend_message' || e.kind === 'group_message' || e.kind === 'temp_message');
      if (!event) continue;

      if (event.kind === 'group_message') {
        out.push({
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
        out.push({
          userUin: event.senderUin,
          nickname: event.senderNick,
          elements: event.elements,
          time: event.time,
          msgId: event.msgId,
          msgSeq: event.msgSeq,
          messageType: 'private',
        });
      } else {
        out.push({
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
    return out;
  }

  /** Recursively resolve forward previews against the piggyback table.
   *  For every `{type: 'forward', resId, forwardUuid}` element we find,
   *  look up the uniseq in the piggyback map; if hit, decode the
   *  inner msgBody and cache it by inner resId, then descend into that
   *  inner layer to resolve deeper nestings carried in the SAME
   *  piggyback set (NapCat hoists the entire tree's piggybacks onto
   *  the outermost action list). */
  private consumePiggybacks(
    nodes: ForwardNodePayload[],
    piggybackByUuid: Map<string, PushMsgBody[]>,
  ): void {
    const seen = new Set<string>();
    const visit = (chain: ForwardNodePayload[]): void => {
      for (const node of chain) {
        for (const elem of node.elements) {
          if (elem.type !== 'forward') continue;
          const uuid = elem.forwardUuid;
          const innerResId = elem.resId;
          if (!uuid || !innerResId || seen.has(uuid)) continue;
          const body = piggybackByUuid.get(uuid);
          if (!body) continue;
          seen.add(uuid);
          const innerNodes = this.decodeMsgBodiesToNodes(body);
          forwardResCache.set(innerResId, cloneNodes(innerNodes));
          visit(innerNodes);
        }
      }
    };
    visit(nodes);
  }
}

function cloneNodes(nodes: ForwardNodePayload[]): ForwardNodePayload[] {
  return nodes.map(node => ({
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
