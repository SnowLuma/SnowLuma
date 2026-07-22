import type {
  SendMessageRequest,
  SendMessageResponse,
} from '@snowluma/proto-defs/action';
import type { FileExtra } from '@snowluma/proto-defs/message';
import type {
  C2CReadedReportResponseItem,
  C2CRecallRequest,
  GroupReadedReportResponseItem,
  GroupRecallRequest,
  SsoReadedReportReq,
  SsoReadedReportResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import { assertWindowShakeSendPolicy } from '@snowluma/protocol/element-manifest';
import { FinalizeOfflineFile } from '@snowluma/protocol/oidb-services/group-file/finalize-offline-file';
import type { MessageElement, QQEventVariant } from '@snowluma/protocol/events';
import {
  fetchC2cMessageRange,
  fetchC2cRoamMessagePage,
  fetchGroupMessageRange,
} from '@snowluma/protocol/msg-push';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { createLogger } from '@snowluma/common/logger';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { BridgeContext } from '../bridge-context';
import { resolveSelfUid } from './shared';
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
const READ_REPORT_CMD = 'trpc.msg.msg_svc.MsgService.SsoReadedReport';
const READ_REPORT_BATCH_SIZE = 100;

const log = createLogger('Bridge.Message');

function decodeReadReportResponse(result: SendPacketResult, label: string): SsoReadedReportResp {
  if (!result.success) {
    throw new Error(result.errorMessage || `${label} transport failed`);
  }
  if (!result.gotResponse || !result.responseData || result.responseData.length === 0) {
    throw new Error(`${label} response is empty`);
  }

  let response: SsoReadedReportResp;
  try {
    response = protobuf_decode<SsoReadedReportResp>(result.responseData);
  } catch (error) {
    throw new Error(`${label} response decode failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resultCode = response.resultCode ?? 0;
  if (resultCode !== 0) {
    throw new Error(response.errorMessage || `${label} failed with result code ${resultCode}`);
  }
  return response;
}

interface C2CReadTarget {
  userId: number;
  uid: string;
}

interface ReadResponseItem {
  resultCode?: number;
  errorMessage?: string;
}

function uniqueSessionIds(ids: readonly number[], label: string): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`invalid ${label} read target ${String(id)}`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function requireReadResponseItem<T extends ReadResponseItem>(
  items: readonly T[] | undefined,
  index: number,
  matches: (item: T) => boolean,
  label: string,
): T {
  const item = items?.find(matches) ?? items?.[index];
  if (!item) throw new Error(`${label} response item is missing`);

  const resultCode = item.resultCode ?? 0;
  if (resultCode !== 0) {
    throw new Error(item.errorMessage || `${label} failed with result code ${resultCode}`);
  }
  if (!matches(item)) throw new Error(`${label} response identity does not match the request`);
  return item;
}

function readUnsignedSequence(value: bigint | null | undefined, label: string): bigint {
  // Proton represents an omitted protobuf scalar as null; protobuf semantics
  // define that as the numeric default (zero), not a decode failure.
  if (value == null) return 0n;
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${label} is invalid`);
  return value;
}

function requirePositiveSequence(value: bigint | null | undefined, label: string): bigint {
  const sequence = readUnsignedSequence(value, label);
  if (sequence === 0n) throw new Error(`${label} is missing`);
  return sequence;
}

type GroupMessage = Extract<QQEventVariant, { kind: 'group_message' }>;
type FriendMessage = Extract<QQEventVariant, { kind: 'friend_message' }>;

// ── Group-history fetch guards (the server frequency-limits / kicks abusive
//    pulls, so keep each request small, bound the loop, and space the sends). ──
const HISTORY_MAX_COUNT = 200;      // hard cap on messages returned per call
const HISTORY_CHUNK_SEQ = 30;       // sequence span per server request (small packet)
const HISTORY_MAX_REQUESTS = 12;    // bound the walk-back loop
const HISTORY_MIN_GAP_MS = 300;     // minimum spacing between SsoGetGroupMsg sends
const HISTORY_MAX_SEQUENCE = 0xffff_ffff; // sequence fields are protobuf uint32

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

/**
 * Shared walk-back loop for group + c2c history: pull HISTORY_CHUNK_SEQ-wide
 * windows ending at `endSeq`, throttled, walking strictly backward (handling a
 * server-side short cap via the oldest sequence actually returned), dedup by
 * sequence, until `count` (capped) is gathered or the floor is reached. Returns
 * the newest `want` items oldest→newest.
 */
async function walkBackHistory<T extends { msgSeq: number }>(
  endSeq: number,
  count: number,
  fetchWindow: (startSeq: number, endSeq: number) => Promise<T[]>,
  sequenceOf: (event: T) => number = (event) => event.msgSeq,
): Promise<T[]> {
  if (!(endSeq > 0)) return [];
  const want = Math.min(Math.max(1, Math.trunc(count) || 0), HISTORY_MAX_COUNT);

  const collected = new Map<number, T>(); // dedup by sequence
  let curEnd = endSeq;
  for (let i = 0; i < HISTORY_MAX_REQUESTS && collected.size < want && curEnd >= 1; i++) {
    const start = Math.max(1, curEnd - HISTORY_CHUNK_SEQ + 1);
    await throttleHistory();
    const batch = await fetchWindow(start, curEnd);
    if (batch.length > 0) {
      let minSeq = curEnd;
      for (const ev of batch) {
        const sequence = sequenceOf(ev);
        if (!Number.isInteger(sequence) || sequence < start || sequence > curEnd) {
          throw new Error(`history response sequence is outside requested range ${start}-${curEnd}`);
        }
        collected.set(sequence, ev);
        if (sequence < minSeq) minSeq = sequence;
      }
      curEnd = minSeq - 1; // strictly below the oldest returned (covers short caps)
    } else {
      curEnd = start - 1; // empty window (recalled/absent seqs) — skip past it
    }
  }
  const all = [...collected.values()].sort((a, b) => sequenceOf(a) - sequenceOf(b));
  return all.slice(-want); // newest `want`, oldest→newest
}

/**
 * Pull sequence windows starting at `startSeq`, retaining the oldest `want`
 * messages at or after the anchor. The returned list is chronological, matching
 * the existing backward-history API shape.
 */
async function walkForwardHistory<T extends { msgSeq: number }>(
  startSeq: number,
  count: number,
  fetchWindow: (startSeq: number, endSeq: number) => Promise<T[]>,
  sequenceOf: (event: T) => number = (event) => event.msgSeq,
): Promise<T[]> {
  if (!(startSeq > 0) || startSeq > HISTORY_MAX_SEQUENCE) return [];
  const want = Math.min(Math.max(1, Math.trunc(count) || 0), HISTORY_MAX_COUNT);

  const collected = new Map<number, T>();
  const budget = { remaining: HISTORY_MAX_REQUESTS };
  let curStart = startSeq;
  while (budget.remaining > 0 && collected.size < want && curStart <= HISTORY_MAX_SEQUENCE) {
    const end = Math.min(HISTORY_MAX_SEQUENCE, curStart + HISTORY_CHUNK_SEQ - 1);
    const window = await fetchForwardWindow(curStart, end, budget, fetchWindow, sequenceOf);
    for (const event of window.messages) collected.set(sequenceOf(event), event);
    if (!window.complete || end === HISTORY_MAX_SEQUENCE) break;
    curStart = end + 1;
  }

  const all = [...collected.values()].sort((a, b) => sequenceOf(a) - sequenceOf(b));
  return all.slice(0, want);
}

interface ForwardWindowResult<T> {
  messages: T[];
  complete: boolean;
}

/**
 * Resolve one forward window from its lower boundary. The history service may
 * short-cap a range to its newest suffix; recursively fetch the omitted prefix
 * before exposing that suffix so callers never skip messages nearest the
 * anchor. An exhausted request budget marks the window incomplete, preventing
 * later messages from being returned ahead of an unresolved prefix.
 */
async function fetchForwardWindow<T extends { msgSeq: number }>(
  startSeq: number,
  endSeq: number,
  budget: { remaining: number },
  fetchWindow: (startSeq: number, endSeq: number) => Promise<T[]>,
  sequenceOf: (event: T) => number,
): Promise<ForwardWindowResult<T>> {
  if (budget.remaining <= 0) return { messages: [], complete: false };

  budget.remaining--;
  await throttleHistory();
  const batch = await fetchWindow(startSeq, endSeq);
  if (batch.length === 0) return { messages: [], complete: true };

  const messages = [...new Map(batch.map((event) => [sequenceOf(event), event])).values()]
    .sort((a, b) => sequenceOf(a) - sequenceOf(b));
  for (const message of messages) {
    const sequence = sequenceOf(message);
    if (!Number.isInteger(sequence) || sequence < startSeq || sequence > endSeq) {
      throw new Error(`history response sequence is outside requested range ${startSeq}-${endSeq}`);
    }
  }
  const firstSequence = sequenceOf(messages[0]!);
  if (firstSequence === startSeq) return { messages, complete: true };

  const prefix = await fetchForwardWindow(
    startSeq,
    firstSequence - 1,
    budget,
    fetchWindow,
    sequenceOf,
  );
  if (!prefix.complete) return prefix;
  return { messages: [...prefix.messages, ...messages], complete: true };
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

    const protoElems = await buildSendElems(elements, {
      bridge: this.ctx as unknown as Bridge,
      groupId,
      scene: 'group',
    });
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
    assertWindowShakeSendPolicy(
      elements.filter((element) => element.type === 'poke').length,
      elements.length,
      'direct-private',
    );

    let userUid = '';
    const hasMedia = elements.some(e => e.type === 'image' || e.type === 'record' || e.type === 'video');
    if (hasMedia) {
      userUid = await this.ctx.resolveUserUid(userUin);
    }

    const protoElems = await buildSendElems(elements, {
      bridge: this.ctx as unknown as Bridge,
      userUid,
      scene: 'direct-private',
    });
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
   * Reply into an existing group temp session (临时会话). Wire primitive only —
   * it does NOT gate; the caller verifies the session before calling. Routes
   * through `grpTmp` (RoutingHead field 3) with { groupUin, toUid } and a normal
   * c2c content head.
   */
  async sendGroupTempMessage(
    userUin: number,
    groupUin: number,
    elements: MessageElement[],
  ): Promise<SendMessageReceipt> {
    if (elements.length === 0) throw new Error('message is empty');
    assertWindowShakeSendPolicy(
      elements.filter((element) => element.type === 'poke').length,
      elements.length,
      'group-temp',
    );

    const userUid = await this.ctx.resolveUserUid(userUin);
    const protoElems = await buildSendElems(elements, {
      bridge: this.ctx as unknown as Bridge,
      userUid,
      scene: 'group-temp',
    });
    const random = this.ctx.nextMessageRandom();
    const clientSeq = this.ctx.nextClientSequence();

    const request = protobuf_encode<SendMessageRequest>({
      routingHead: {
        grpTmp: { groupUin: BigInt(groupUin), toUid: userUid },
      },
      contentHead: { type: 1, subType: 0, c2cCmd: 11 },
      messageBody: { richText: { elems: protoElems } },
      clientSequence: clientSeq,
      random,
      syncCookie: new Uint8Array(0),
      via: 0,
      dataStatist: 0,
      ctrl: { msgFlag: Math.floor(Date.now() / 1000) },
      multiSendSeq: 0,
    });

    const result = await this.ctx.sendRawPacket(SEND_MSG_CMD, request);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send temp message failed: ${result.errorMessage || 'no response'}`);
    }
    const response = protobuf_decode<SendMessageResponse>(result.responseData);
    if (!response) throw new Error('failed to decode SendMessageResponse');
    if (response.result != null && response.result !== 0) {
      throw new Error(`send temp message rejected: result=${response.result} err=${response.errMsg ?? ''}`);
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
   *
   * `FileExtra.file` alone makes the file downloadable (verified on a live
   * account). We ALSO attach `FileExtra.field6` — extra server-issued download
   * routing from a best-effort 0xE37_800 finalize that mirrors NapCat and may
   * help some receiver clients. The finalize is non-fatal: if it fails we send
   * without field6 rather than failing the send (issue #157).
   */
  async sendC2cFile(
    userUin: number,
    userUid: string,
    info: { fileId: string; fileName: string; fileSize: number; fileMd5: Uint8Array; fileHash?: string },
  ): Promise<SendMessageReceipt> {
    const random = this.ctx.nextMessageRandom();
    const clientSeq = this.ctx.nextClientSequence();

    // Resolve our own uid — needed both for the 0xE37_800 finalize and the
    // `field6` download-routing the receiver reads.
    const selfUid = await resolveSelfUid(this.ctx);

    // The file is already downloadable from the `NotOnlineFile` reference
    // alone — verified on a live account: a plain c2c file send (no field6)
    // downloads fine. `field6` is EXTRA server-issued download routing (from
    // the 0xE37_800 finalize) that mirrors NapCat and may help some receiver
    // clients. So fetch it BEST-EFFORT: if the finalize fails, send without
    // field6 rather than failing the whole send. (issue #157 — the finalize
    // was originally fatal, which could regress a send that would otherwise
    // succeed.)
    const fileHash = info.fileHash ?? '';
    let meta: Awaited<ReturnType<typeof FinalizeOfflineFile.invoke>> | null = null;
    try {
      meta = await FinalizeOfflineFile.invoke(this.ctx, {
        senderUid: selfUid,
        receiverUid: userUid,
        fileUuid: info.fileId,
        fileHash,
      });
    } catch (err) {
      log.warn('c2c file finalize (0xE37_800) failed, sending without field6: %s',
        err instanceof Error ? err.message : String(err));
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysSec = 7 * 24 * 60 * 60;
    const fileExtra: FileExtra = {
      file: {
        fileType: 0,
        fileUuid: info.fileId,
        fileMd5: info.fileMd5,
        fileName: info.fileName,
        fileSize: BigInt(info.fileSize),
        subcmd: 1,
        dangerEvel: 0,
        expireTime: nowSec + sevenDaysSec,
        fileHash,
      },
    };
    if (meta) {
      fileExtra.field6 = {
        field2: {
          field1: meta.field110,
          fileUuid: info.fileId,
          fileName: info.fileName,
          field6: meta.field3,
          field7: meta.field101,
          field8: meta.field100,
          timestamp1: meta.timestamp1,
          fileHash,
          selfUid,
          destUid: userUid,
        },
      };
    }
    const fileExtraBytes = protobuf_encode<FileExtra>(fileExtra);

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

  /** Mark the entire group conversation read, matching QQ NT's setMsgRead(peer). */
  async markGroupRead(groupId: number): Promise<void> {
    await this.markAllRead([groupId], []);
  }

  /** Mark the entire private conversation read, matching QQ NT's setMsgRead(peer). */
  async markPrivateRead(userId: number): Promise<void> {
    await this.markAllRead([], [userId]);
  }

  /**
   * Mark every supplied conversation read through SsoReadedReport.
   *
   * Message-head sequences are not valid C2C read sequences. The first packet
   * therefore reports zero for every conversation and reads the server's
   * current read/latest pair from the response without moving the marker
   * backwards. A second packet advances only conversations that are behind.
   * QQ NT caps each packet at 100 C2C plus 100 group entries and waits for the
   * response before sending the next page; mirror that strictly here.
   */
  async markAllRead(groupIds: readonly number[], privateUserIds: readonly number[]): Promise<void> {
    const groups = uniqueSessionIds(groupIds, 'group');
    const privateUsers = uniqueSessionIds(privateUserIds, 'private');
    const c2cTargets: C2CReadTarget[] = [];

    // Keep UID resolution sequential. A cache miss may itself use the network,
    // so Promise.all here would reintroduce the burst this method is designed
    // to avoid.
    for (const userId of privateUsers) {
      const uid = await this.ctx.resolveUserUid(userId);
      if (!uid) throw new Error(`failed to resolve uid for private read target ${userId}`);
      c2cTargets.push({ userId, uid });
    }

    const totalBatches = Math.max(
      Math.ceil(groups.length / READ_REPORT_BATCH_SIZE),
      Math.ceil(c2cTargets.length / READ_REPORT_BATCH_SIZE),
    );
    if (totalBatches === 0) return;

    log.debug(
      'mark-read start: groups=%d c2c=%d batches=%d',
      groups.length,
      c2cTargets.length,
      totalBatches,
    );

    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const start = batchIndex * READ_REPORT_BATCH_SIZE;
      await this.markReadBatch(
        groups.slice(start, start + READ_REPORT_BATCH_SIZE),
        c2cTargets.slice(start, start + READ_REPORT_BATCH_SIZE),
        batchIndex + 1,
        totalBatches,
      );
    }

    log.debug('mark-read complete: groups=%d c2c=%d', groups.length, c2cTargets.length);
  }

  private async sendReadReport(request: SsoReadedReportReq, label: string): Promise<SsoReadedReportResp> {
    log.debug(
      '%s send: groups=%d c2c=%d',
      label,
      request.groupList?.length ?? 0,
      request.c2cList?.length ?? 0,
    );
    const payload = protobuf_encode<SsoReadedReportReq>(request);
    const result = await this.ctx.sendRawPacket(READ_REPORT_CMD, payload);
    const response = decodeReadReportResponse(result, label);
    log.debug(
      '%s response: groups=%d c2c=%d',
      label,
      response.groupList?.length ?? 0,
      response.c2cList?.length ?? 0,
    );
    return response;
  }

  private groupReadResponse(
    response: SsoReadedReportResp,
    groupId: number,
    index: number,
    label: string,
  ): GroupReadedReportResponseItem {
    const groupUin = BigInt(groupId);
    return requireReadResponseItem(
      response.groupList,
      index,
      item => item.groupUin === groupUin,
      `${label} group ${groupId}`,
    );
  }

  private c2cReadResponse(
    response: SsoReadedReportResp,
    target: C2CReadTarget,
    index: number,
    label: string,
  ): C2CReadedReportResponseItem {
    return requireReadResponseItem(
      response.c2cList,
      index,
      item => item.uid === target.uid,
      `${label} private user ${target.userId}`,
    );
  }

  private async markReadBatch(
    groupIds: readonly number[],
    c2cTargets: readonly C2CReadTarget[],
    batchIndex: number,
    totalBatches: number,
  ): Promise<void> {
    const batchLabel = `mark-read batch ${batchIndex}/${totalBatches}`;
    const probe = await this.sendReadReport({
      groupList: groupIds.map(groupId => ({ groupUin: BigInt(groupId), lastReadSeq: 0n })),
      c2cList: c2cTargets.map(target => ({ uid: target.uid, lastReadTime: 0n, lastReadSeq: 0n })),
    }, `${batchLabel} probe`);

    const groupList: NonNullable<SsoReadedReportReq['groupList']> = [];
    for (let i = 0; i < groupIds.length; i++) {
      const groupId = groupIds[i]!;
      const item = this.groupReadResponse(probe, groupId, i, `${batchLabel} probe`);
      const readSeq = readUnsignedSequence(item.readSeq, `${batchLabel} group ${groupId} read sequence`);
      const latestSeq = readUnsignedSequence(item.latestSeq, `${batchLabel} group ${groupId} latest sequence`);
      if (latestSeq < readSeq) {
        throw new Error(`${batchLabel} group ${groupId} latest sequence ${latestSeq} is before read sequence ${readSeq}`);
      }
      if (latestSeq > readSeq) groupList.push({ groupUin: BigInt(groupId), lastReadSeq: latestSeq });
    }

    const c2cList: NonNullable<SsoReadedReportReq['c2cList']> = [];
    const c2cConfirmTargets: C2CReadTarget[] = [];
    for (let i = 0; i < c2cTargets.length; i++) {
      const target = c2cTargets[i]!;
      const item = this.c2cReadResponse(probe, target, i, `${batchLabel} probe`);
      const readSeq = readUnsignedSequence(item.readSeq, `${batchLabel} private user ${target.userId} read sequence`);
      const latestSeq = readUnsignedSequence(item.latestSeq, `${batchLabel} private user ${target.userId} latest sequence`);
      if (latestSeq < readSeq) {
        throw new Error(
          `${batchLabel} private user ${target.userId} latest sequence ${latestSeq} is before read sequence ${readSeq}`,
        );
      }
      if (latestSeq > readSeq) {
        const lastMsgTime = requirePositiveSequence(
          item.lastMsgTime,
          `${batchLabel} private user ${target.userId} last message time`,
        );
        c2cList.push({ uid: target.uid, lastReadTime: lastMsgTime, lastReadSeq: latestSeq });
        c2cConfirmTargets.push(target);
      }
    }

    if (groupList.length === 0 && c2cList.length === 0) {
      log.debug('%s already current', batchLabel);
      return;
    }

    const confirm = await this.sendReadReport({ groupList, c2cList }, `${batchLabel} confirm`);
    for (let i = 0; i < groupList.length; i++) {
      const requested = groupList[i]!;
      const groupId = Number(requested.groupUin);
      const item = this.groupReadResponse(confirm, groupId, i, `${batchLabel} confirm`);
      const readSeq = readUnsignedSequence(item.readSeq, `${batchLabel} group ${groupId} confirmed read sequence`);
      if (readSeq < (requested.lastReadSeq ?? 0n)) {
        throw new Error(
          `${batchLabel} group ${groupId} confirmed sequence ${readSeq} before requested ${requested.lastReadSeq}`,
        );
      }
    }
    for (let i = 0; i < c2cList.length; i++) {
      const requested = c2cList[i]!;
      const target = c2cConfirmTargets[i]!;
      const item = this.c2cReadResponse(confirm, target, i, `${batchLabel} confirm`);
      const readSeq = readUnsignedSequence(
        item.readSeq,
        `${batchLabel} private user ${target.userId} confirmed read sequence`,
      );
      if (readSeq < (requested.lastReadSeq ?? 0n)) {
        throw new Error(
          `${batchLabel} private user ${target.userId} confirmed sequence ${readSeq} before requested ${requested.lastReadSeq}`,
        );
      }
    }
  }

  /**
   * Fetch real group history from the server (`SsoGetGroupMsg`), including the
   * anchor and walking backward or forward in small windows. Rate-limited and
   * capped so a hammering client cannot flood the server. Returns decoded
   * `group_message` events oldest→newest regardless of query direction.
   */
  async getGroupHistory(
    groupUin: number,
    anchorSeq: number,
    count: number,
    selfUin = 0,
    reverseOrder = true,
  ): Promise<GroupMessage[]> {
    if (!(groupUin > 0)) return [];
    const fetchWindow = (start: number, end: number) =>
      fetchGroupMessageRange(this.ctx, this.ctx.identity, selfUin, groupUin, start, end);
    return reverseOrder
      ? walkBackHistory(anchorSeq, count, fetchWindow)
      : walkForwardHistory(anchorSeq, count, fetchWindow);
  }

  /**
   * Fetch real private history from the server (`SsoGetC2cMsg`), including the
   * anchor in the requested direction. It shares the group variant's throttle
   * and data-volume guards. Returns decoded events oldest→newest.
   */
  async getC2cHistory(
    friendUid: string,
    anchorSeq: number,
    count: number,
    selfUin = 0,
    reverseOrder = true,
  ): Promise<FriendMessage[]> {
    if (!friendUid) return [];
    const fetchWindow = (start: number, end: number) =>
      fetchC2cMessageRange(this.ctx, this.ctx.identity, selfUin, friendUid, start, end);
    const serverSequence = (message: FriendMessage) => message.ntMsgSeq ?? 0;
    return reverseOrder
      ? walkBackHistory(anchorSeq, count, fetchWindow, serverSequence)
      : walkForwardHistory(anchorSeq, count, fetchWindow, serverSequence);
  }

  /**
   * Fetch the latest private history page without relying on a locally cached
   * sequence. C2C field-5 sequences are sender-local, so only SsoGetRoamMsg's
   * timestamp cursor can safely bootstrap an unanchored conversation.
   */
  async getC2cLatestHistory(
    friendUid: string,
    count: number,
    selfUin = 0,
    beforeTime = Math.floor(Date.now() / 1000) + 1,
  ): Promise<FriendMessage[]> {
    if (!friendUid) return [];
    const want = Math.min(Math.max(1, Math.trunc(count) || 0), HISTORY_MAX_COUNT);
    const collected = new Map<number, FriendMessage>();
    let cursor = { time: beforeTime, random: 0 };
    const seenCursors = new Set<string>([`${cursor.time}:${cursor.random}`]);
    let reachedEnd = false;

    for (let i = 0; i < HISTORY_MAX_REQUESTS && collected.size < want; i++) {
      await throttleHistory();
      const page = await fetchC2cRoamMessagePage(
        this.ctx,
        this.ctx.identity,
        selfUin,
        friendUid,
        cursor.time,
        want - collected.size,
        cursor.random,
      );
      for (const message of page.messages) {
        const sequence = message.ntMsgSeq ?? 0;
        if (!Number.isSafeInteger(sequence) || sequence <= 0) {
          throw new Error(`private roam history returned invalid NT sequence ${String(sequence)}`);
        }
        collected.set(sequence, message);
      }

      if (collected.size >= want) break;
      if (page.cursor.time === 0 && page.cursor.random === 0) {
        reachedEnd = true;
        break;
      }
      const nextCursorKey = `${page.cursor.time}:${page.cursor.random}`;
      if (seenCursors.has(nextCursorKey)) {
        if (page.messages.length === 0) {
          reachedEnd = true;
          break;
        }
        throw new Error(
          `private roam history cursor did not advance from ${cursor.time}/${cursor.random}`,
        );
      }
      seenCursors.add(nextCursorKey);
      cursor = page.cursor;
    }

    if (collected.size < want && !reachedEnd) {
      throw new Error(
        `private roam history request budget exhausted after ${HISTORY_MAX_REQUESTS} pages `
        + `(requested=${want}, collected=${collected.size})`,
      );
    }

    return [...collected.values()]
      .sort((a, b) => (a.ntMsgSeq ?? 0) - (b.ntMsgSeq ?? 0) || a.time - b.time)
      .slice(-want);
  }

  /**
   * Fetch a single group message by its exact sequence — `SsoGetGroupMsg` over a
   * 1-wide `[seq, seq]` range, through the shared history throttle gate. Used to
   * back-fill a replied-to message the local store never saw. Returns the
   * matching `group_message`, or null if absent / on error.
   */
  async getGroupMessageBySeq(groupUin: number, seq: number, selfUin = 0): Promise<GroupMessage | null> {
    if (!(groupUin > 0) || !(seq > 0)) return null;
    await throttleHistory();
    try {
      const batch = await fetchGroupMessageRange(this.ctx, this.ctx.identity, selfUin, groupUin, seq, seq);
      return batch.find((m) => m.msgSeq === seq) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a single c2c message by its exact conversation-wide NT sequence —
   * `SsoGetC2cMsg` over a 1-wide `[seq, seq]` range, through the same throttle
   * gate. Sender-local reply/recall sequences must not be passed here.
   */
  async getC2cMessageBySeq(friendUid: string, seq: number, selfUin = 0): Promise<FriendMessage | null> {
    if (!friendUid || !(seq > 0)) return null;
    await throttleHistory();
    try {
      const batch = await fetchC2cMessageRange(this.ctx, this.ctx.identity, selfUin, friendUid, seq, seq);
      return batch.find((m) => m.ntMsgSeq === seq) ?? null;
    } catch {
      return null;
    }
  }
}
