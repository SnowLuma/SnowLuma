import type {
  SendMessageRequest,
  SendMessageResponse,
} from '@snowluma/proto-defs/action';
import type { FileExtra } from '@snowluma/proto-defs/message';
import type {
  C2CRecallRequest,
  GroupRecallRequest,
  SsoReadedReportReq,
} from '@snowluma/proto-defs/oidb-actions/base';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import type { MessageElement, QQEventVariant } from '@snowluma/protocol/events';
import { fetchGroupMessageRange } from '@snowluma/protocol/msg-push';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { BridgeContext } from '../bridge-context';
// `Bridge` is imported as a type only so we can narrow `ctx` back to
// the concrete Bridge instance when passing it to `buildSendElems`
// (which still takes `Bridge` because the highway upload helpers it
// transitively calls each take `Bridge` — refactoring those is a
// separate concern that doesn't need to land alongside the Api split).
//
// At runtime `ctx` IS the Bridge instance that constructed this
// MessageApi — `buildApiHub(ctx)` passes the Bridge itself.
import type { Bridge, SendMessageReceipt } from '../bridge';

const SEND_MSG_CMD = 'MessageSvc.PbSendMsg';

type GroupMessage = Extract<QQEventVariant, { kind: 'group_message' }>;

// ── Group-history fetch guards (the server frequency-limits / kicks abusive
//    pulls, so keep each request small, bound the loop, and space the sends). ──
const HISTORY_MAX_COUNT = 200;      // hard cap on messages returned per call
const HISTORY_CHUNK_SEQ = 30;       // sequence span per server request (small packet)
const HISTORY_MAX_REQUESTS = 12;    // bound the walk-back loop
const HISTORY_MIN_GAP_MS = 300;     // minimum spacing between SsoGetGroupMsg sends

// Serialized throttle gate: chains so concurrent callers queue, and enforces
// at least HISTORY_MIN_GAP_MS between actual sends (the first send isn't
// penalized). Process-wide — shared across all groups AND accounts in this
// process — so no client can make us flood the server regardless of fan-out.
let historyLastSendAt = 0;
let historyGate: Promise<void> = Promise.resolve();
function throttleHistory(): Promise<void> {
  const run = historyGate.then(async () => {
    const wait = historyLastSendAt + HISTORY_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    historyLastSendAt = Date.now();
  });
  historyGate = run.catch(() => undefined);
  return run;
}

export class MessageApi {
  constructor(private readonly ctx: BridgeContext) { }

  /**
   * Send a message to a QQ group.
   *
   * Wraps `MessageSvc.PbSendMsg` with `routingHead.grp.groupCode`.
   * Media elements (image / record / video) trigger highway uploads
   * inside `buildSendElems` — see `element-builder.ts`.
   *
   * Returns a `SendMessageReceipt` carrying the assigned messageId,
   * group sequence, and timestamps; callers cache this for later
   * `recall` / reply lookups.
   */
  async sendGroup(groupId: number, elements: MessageElement[]): Promise<SendMessageReceipt> {
    if (elements.length === 0) throw new Error('message is empty');

    const protoElems = await buildSendElems(elements, { bridge: this.ctx as unknown as Bridge, groupId });
    const random = this.ctx.nextMessageRandom();

    const request = protobuf_encode<SendMessageRequest>({
      routingHead: {
        grp: { groupCode: BigInt(groupId) },
      },
      contentHead: {
        type: 1,
      },
      messageBody: {
        richText: {
          elems: protoElems,
        },
      },
      clientSequence: 0,
      random,
      syncCookie: new Uint8Array(0),
      via: 0,
      dataStatist: 0,
      multiSendSeq: 0,
    });

    const result = await this.ctx.sendRawPacket(SEND_MSG_CMD, request);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send group message failed: ${result.errorMessage || 'no response'}`);
    }

    const response = protobuf_decode<SendMessageResponse>(result.responseData);
    if (!response) throw new Error('failed to decode SendMessageResponse');
    if (response.result != null && response.result !== 0) {
      throw new Error(`send group message rejected: result=${response.result} err=${response.errMsg ?? ''}`);
    }

    const seq = response.groupSequence ?? 0;
    const messageId = (random & 0x7FFFFFFF) || seq;
    const timestamp = response.timestamp1 ?? Math.floor(Date.now() / 1000);
    return { messageId, sequence: seq, clientSequence: 0, random, timestamp };
  }

  /**
   * Send a c2c (private) message.
   *
   * Resolves the recipient's UID only when the message carries media
   * — text-only messages skip the lookup. Routes through `c2c.uin`
   * (and optionally `c2c.uid` for the media case).
   */
  async sendPrivate(userUin: number, elements: MessageElement[]): Promise<SendMessageReceipt> {
    if (elements.length === 0) throw new Error('message is empty');

    let userUid = '';
    const hasMedia = elements.some(e => e.type === 'image' || e.type === 'record' || e.type === 'video');
    if (hasMedia) {
      userUid = await this.ctx.resolveUserUid(userUin);
    }

    const protoElems = await buildSendElems(elements, { bridge: this.ctx as unknown as Bridge, userUid });
    const random = this.ctx.nextMessageRandom();
    const clientSeq = this.ctx.nextClientSequence();

    const request = protobuf_encode<SendMessageRequest>({
      routingHead: {
        c2c: {
          uin: userUin,
          ...(userUid ? { uid: userUid } : {}),
        },
      },
      contentHead: {
        type: 1,
        subType: 0,
        c2cCmd: 11,
      },
      messageBody: {
        richText: {
          elems: protoElems,
        },
      },
      clientSequence: clientSeq,
      random,
      syncCookie: new Uint8Array(0),
      via: 0,
      dataStatist: 0,
      ctrl: {
        msgFlag: Math.floor(Date.now() / 1000),
      },
      multiSendSeq: 0,
    });

    const result = await this.ctx.sendRawPacket(SEND_MSG_CMD, request);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send private message failed: ${result.errorMessage || 'no response'}`);
    }

    const response = protobuf_decode<SendMessageResponse>(result.responseData);
    if (!response) throw new Error('failed to decode SendMessageResponse');
    if (response.result != null && response.result !== 0) {
      throw new Error(`send private message rejected: result=${response.result} err=${response.errMsg ?? ''}`);
    }

    const seq = response.privateSequence ?? 0;
    const messageId = (random & 0x7FFFFFFF) || seq;
    const timestamp = response.timestamp1 ?? Math.floor(Date.now() / 1000);
    return { messageId, sequence: seq, clientSequence: clientSeq, random, timestamp };
  }

  /**
   * Send a c2c file as a chat message.
   *
   * The wire shape isn't the same as a regular c2c message — the c2c
   * file path uses three slots that differ from a normal text/image
   * send (verified against `dev/Lagrange.Core/.../MessagePacker.cs:
   * BuildPacketBase` + `FileEntity.PackMessageContent`):
   *
   *   1. `routingHead.trans0x211 { ccCmd: 4, uid: peer }` instead of
   *      `routingHead.c2c { uin, uid }`. The server rejects c2c file
   *      messages routed through the regular c2c slot.
   *   2. `messageBody.msgContent` carries the serialised
   *      `FileExtra { file: NotOnlineFile }` bytes. NOT
   *      `richText.notOnlineFile` — the receiver doesn't read that
   *      slot for file metadata.
   *   3. `contentHead.c2cCmd` left at 0 (Lagrange's default). The
   *      previous `c2cCmd: 11` was a stale go-cqhttp value the QQ-NT
   *      server doesn't recognise.
   *
   * NotOnlineFile carries three required-on-send fields the receiver
   * itself ignores but the server's intake validator checks:
   *   - `subcmd: 1`     — c2c file send command code
   *   - `dangerEvel: 0` — virus-scan severity, always 0 client-side
   *   - `expireTime`    — 7 days from now (Lagrange convention)
   */
  async sendC2cFile(
    userUin: number,
    userUid: string,
    info: { fileId: string; fileName: string; fileSize: number; fileMd5: Uint8Array; fileHash?: string },
  ): Promise<SendMessageReceipt> {
    const random = this.ctx.nextMessageRandom();
    const clientSeq = this.ctx.nextClientSequence();

    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysSec = 7 * 24 * 60 * 60;
    const fileExtraBytes = protobuf_encode<FileExtra>({
      file: {
        fileType: 0,
        fileUuid: info.fileId,
        fileMd5: info.fileMd5,
        fileName: info.fileName,
        fileSize: BigInt(info.fileSize),
        subcmd: 1,
        dangerEvel: 0,
        expireTime: nowSec + sevenDaysSec,
        fileHash: info.fileHash ?? '',
      },
    });

    const request = protobuf_encode<SendMessageRequest>({
      routingHead: {
        trans0x211: { ccCmd: 4, uid: userUid },
      },
      contentHead: {
        type: 1,
        subType: 0,
      },
      messageBody: {
        msgContent: fileExtraBytes,
      },
      clientSequence: clientSeq,
      random,
      syncCookie: new Uint8Array(0),
      via: 0,
      dataStatist: 0,
      ctrl: { msgFlag: nowSec },
      multiSendSeq: 0,
    });

    // `userUin` is part of the public contract (the OneBot layer
    // threads it through for symmetry with `sendPrivate`) but the
    // wire shape only needs the uid. Silence the unused-parameter
    // lint without changing the signature.
    void userUin;

    const result = await this.ctx.sendRawPacket(SEND_MSG_CMD, request);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send c2c file message failed: ${result.errorMessage || 'no response'}`);
    }
    const response = protobuf_decode<SendMessageResponse>(result.responseData);
    if (!response) throw new Error('failed to decode SendMessageResponse');
    if (response.result != null && response.result !== 0) {
      throw new Error(`send c2c file message rejected: result=${response.result} err=${response.errMsg ?? ''}`);
    }
    const seq = response.privateSequence ?? 0;
    const messageId = (random & 0x7FFFFFFF) || seq;
    const timestamp = response.timestamp1 ?? Math.floor(Date.now() / 1000);
    return { messageId, sequence: seq, clientSequence: clientSeq, random, timestamp };
  }

  /**
   * Recall (revoke) a group message by sequence number. Server-side
   * the message ages out after the standard 2-minute window unless
   * the user is an admin/owner.
   */
  async recallGroup(groupId: number, sequence: number): Promise<void> {
    const request = protobuf_encode<GroupRecallRequest>({
      type: 1,
      groupUin: groupId,
      info: { sequence, random: 0, field3: 0 },
      settings: { field1: 0 },
    });
    const result = await this.ctx.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg', request);
    if (!result.success) throw new Error(result.errorMessage || 'recall group message failed');
  }

  /**
   * Recall a c2c (private) message. Needs more positional info than
   * the group variant because c2c messages are identified by the
   * `(clientSequence, msgSequence, random, timestamp)` tuple rather
   * than a single group-side sequence.
   */
  async recallPrivate(
    userUin: number,
    clientSeq: number,
    msgSeq: number,
    random: number,
    timestamp: number,
  ): Promise<void> {
    const targetUid = await this.ctx.resolveUserUid(userUin);
    const request = protobuf_encode<C2CRecallRequest>({
      type: 1,
      targetUid,
      info: {
        clientSequence: clientSeq,
        random,
        messageId: BigInt((0x01000000 * 0x100000000) + random),
        timestamp,
        field5: 0,
        messageSequence: msgSeq,
      },
      settings: { field1: false, field2: false },
      field6: false,
    });
    const result = await this.ctx.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg', request);
    if (!result.success) throw new Error(result.errorMessage || 'recall private message failed');
  }

  /**
   * Push a group read-report (`trpc.msg.msg_svc.MsgService.SsoReadedReport`)
   * advancing the bot's last-read marker to `sequence`. Mirrors the QQ
   * NT client's own "scrolled to bottom" behaviour so subsequent
   * sync packets don't replay messages we've already processed.
   */
  async markGroupRead(groupId: number, sequence: number): Promise<void> {
    const request = protobuf_encode<SsoReadedReportReq>({
      groupList: [
        {
          groupUin: BigInt(groupId),
          lastReadSeq: BigInt(sequence),
        },
      ],
    });
    const result = await this.ctx.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoReadedReport', request);
    if (!result.success) {
      throw new Error(result.errorMessage || 'mark group message read failed');
    }
  }

  /**
   * Push a c2c read-report. Same wire-cmd as the group variant but
   * keyed by friend uid (resolved from uin via IdentityService).
   * `lastReadTime` defaults to "now" — matches the QQ NT client
   * which also uses wall-clock seconds rather than the read-message
   * timestamp.
   */
  async markPrivateRead(userId: number, sequence: number): Promise<void> {
    const uid = await this.ctx.resolveUserUid(userId);
    const request = protobuf_encode<SsoReadedReportReq>({
      c2cList: [
        {
          uid,
          lastReadTime: BigInt(Math.floor(Date.now() / 1000)),
          lastReadSeq: BigInt(sequence),
        },
      ],
    });
    const result = await this.ctx.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoReadedReport', request);
    if (!result.success) {
      throw new Error(result.errorMessage || 'mark private message read failed');
    }
  }

  /**
   * Fetch real group history from the server (`SsoGetGroupMsg`), ending at and
   * including `endSeq`, walking backward in small windows until `count`
   * messages are gathered or the floor is reached. Rate-limited + capped so a
   * hammering client can't make us flood the server (and get the account
   * kicked). Returns decoded `group_message` events oldest→newest.
   */
  async getGroupHistory(groupUin: number, endSeq: number, count: number, selfUin = 0): Promise<GroupMessage[]> {
    if (!(groupUin > 0) || !(endSeq > 0)) return [];
    const want = Math.min(Math.max(1, Math.trunc(count) || 0), HISTORY_MAX_COUNT);

    const collected = new Map<number, GroupMessage>(); // dedup by sequence
    let curEnd = endSeq;
    for (let i = 0; i < HISTORY_MAX_REQUESTS && collected.size < want && curEnd >= 1; i++) {
      const start = Math.max(1, curEnd - HISTORY_CHUNK_SEQ + 1);
      await throttleHistory();
      let batch: GroupMessage[];
      try {
        batch = await fetchGroupMessageRange(this.ctx, this.ctx.identity, selfUin, groupUin, start, curEnd);
      } catch {
        break; // network/decode error — return whatever we have so far
      }
      if (batch.length > 0) {
        let minSeq = curEnd;
        for (const ev of batch) {
          collected.set(ev.msgSeq, ev);
          if (ev.msgSeq < minSeq) minSeq = ev.msgSeq;
        }
        // Continue strictly below the OLDEST sequence the server actually
        // returned — covers the case where the server caps a window short.
        curEnd = minSeq - 1;
      } else {
        // Empty window (a gap of recalled/absent seqs) — skip past it.
        curEnd = start - 1;
      }
    }

    const all = [...collected.values()].sort((a, b) => a.msgSeq - b.msgSeq);
    return all.slice(-want); // newest `want`, oldest→newest
  }
}

