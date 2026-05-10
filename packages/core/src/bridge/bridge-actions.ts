// Admin / action operations extracted from Bridge.

import type { Bridge } from './bridge';
import type { PacketInfo } from '../protocol/types';
import { protoDecode, protoEncode } from '../protobuf/decode';
import { sendOidbAndCheck, sendOidbAndDecode, resolveUserUid } from './bridge-oidb';
import { fetchHighwaySession, uploadHighwayHttp } from './highway/highway-client';
import { computeHashes, computeMd5, loadBinarySource } from './highway/utils';
import { buildSendElems } from './builders/element-builder';
import { parseMsgPush } from './handlers/msg-push-handler';
import type { ForwardNodePayload, MessageElement } from './events';
import { createLogger } from '../utils/logger';
import { PushMsgSchema } from './proto/message';
import {
  OidbMuteMemberSchema,
  OidbMuteAllSchema,
  Oidb0x89a_0AddOptionSchema,
  Oidb0x89a_0SearchSchema,
  OidbKickMemberSchema,
  OidbLeaveGroupSchema,
  OidbFriendRequestActionSchema,
  OidbDeleteFriendSchema,
  OidbGroupRequestActionSchema,
  OidbPokeSchema,
  OidbEssenceSchema,
  OidbSetAdminSchema,
  OidbRenameMemberSchema,
  OidbRenameGroupSchema,
  OidbSpecialTitleSchema,
  OidbLikeSchema,
  OidbGroupReactionSchema,
  OidbSetFriendRemarkSchema,
  OidbGroupFileCountViewReqSchema,
  OidbGroupFileCountViewRespSchema,
  OidbGroupFileViewReqSchema,
  OidbGroupFileViewRespSchema,
  OidbGroupFileReqSchema,
  OidbGroupFileRespSchema,
  OidbGroupFileFolderReqSchema,
  OidbGroupFileFolderRespSchema,
  OidbPrivateFileDownloadReqSchema,
  OidbPrivateFileDownloadRespSchema,
  OidbPrivateFileUploadReqSchema,
  OidbPrivateFileUploadRespSchema,
  NTV2RichMediaReqSchema,
  NTV2RichMediaRespSchema,
  GroupRecallRequestSchema,
  C2CRecallRequestSchema,
  SsoReadedReportReqSchema,
  SetStatusReqSchema,
  SetStatusRespSchema,
  OidbSetProfileSchema,
  Oidb0x7edReqSchema,
  Oidb0x7edRespSchema,
  Oidb0x8a0ReqSchema,
  Oidb0x8a0RespSchema,
  Oidb0xf16ReqSchema,
  Oidb0xf16RespSchema,
  Oidb0x8a7RespSchema,
  Oidb0x8a7ReqSchema,
  Oidb0xe17RespSchema,
  Oidb0xe17ReqSchema,
  Oidb0x112aReqSchema,
  Oidb0x112aRespSchema,
  Oidb0xcd4ReqSchema,
  Oidb0xcd4RespSchema,
  Oidb0x990ReqSchema,
  Oidb0x990RespSchema,
  MiniAppShareReqSchema,
  MiniAppShareRespSchema,
  Oidb0x112eReqSchema,
  Oidb0x112eRespSchema,
  Oidb0xeb7ReqSchema,
  Oidb0xeb7RespSchema,
  FaceroamOpReqSchema,
  FaceroamOpRespSchema,
  Oidb0x9083ReqSchema,
  Oidb0x9083RespSchema,
} from './proto/oidb-action';
import { FileUploadExtSchema } from './proto/highway';
import {
  LongMsgResultSchema,
  RecvLongMsgReqSchema,
  RecvLongMsgRespSchema,
  SendLongMsgReqSchema,
  SendLongMsgRespSchema,
} from './proto/longmsg';
import { gzipSync, gunzipSync } from 'zlib';

const log = createLogger('BridgeActions');

export interface GroupFileInfo {
  fileId: string;
  fileName: string;
  busId: number;
  fileSize: number;
  uploadTime: number;
  deadTime: number;
  modifyTime: number;
  downloadTimes: number;
  uploader: number;
  uploaderName: string;
}

export interface GroupFolderInfo {
  folderId: string;
  folderName: string;
  createTime: number;
  creator: number;
  creatorName: string;
  totalFileCount: number;
}

export interface GroupFilesResult {
  files: GroupFileInfo[];
  folders: GroupFolderInfo[];
}

export interface UploadFileResult {
  fileId: string | null;
  fileHash?: string | null;
}

export interface MediaIndexNode {
  info?: {
    fileSize?: number;
    fileHash?: string;
    fileSha1?: string;
    fileName?: string;
    width?: number;
    height?: number;
    time?: number;
    original?: number;
    type?: {
      type?: number;
      picFormat?: number;
      videoFormat?: number;
      voiceFormat?: number;
    };
  };
  fileUuid?: string;
  storeId?: number;
  uploadTime?: number;
  ttl?: number;
  subType?: number;
}

const forwardResCache = new Map<string, ForwardNodePayload[]>();

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

function ensureRetCodeZero(operation: string, code: unknown, msg: unknown, wording: unknown): void {
  const retCode = toInt(code);
  if (retCode === 0) return;
  const text = (typeof wording === 'string' && wording) || (typeof msg === 'string' && msg) || 'unknown error';
  throw new Error(`${operation} failed: code=${retCode} msg=${text}`);
}

function normalizeDirectory(dir?: string): string {
  if (!dir || !dir.trim()) return '/';
  return dir;
}

function bytesToHexUpper(data: unknown): string {
  if (!(data instanceof Uint8Array) || data.length === 0) return '';
  return Buffer.from(data).toString('hex').toUpperCase();
}

function normalizeUploadFileName(name: string, fallback: string): string {
  const trimmed = name.trim();
  if (trimmed) return trimmed;
  const safeFallback = fallback.trim();
  return safeFallback || 'file.bin';
}

function md5First10MB(bytes: Uint8Array): Uint8Array {
  const limit = Math.min(bytes.length, 10 * 1024 * 1024);
  return computeMd5(bytes.subarray(0, limit));
}

function buildGroupFileUploadExt(
  senderUin: number,
  groupId: number,
  fileName: string,
  fileSize: number,
  md5: Uint8Array,
  fileId: string,
  uploadKey: Uint8Array,
  checkKey: Uint8Array,
  uploadHost: string,
  uploadPort: number,
): Uint8Array {
  return protoEncode({
    unknown1: 100,
    unknown2: 1,
    entry: {
      busiBuff: {
        busId: 102,
        senderUin: BigInt(senderUin),
        receiverUin: BigInt(groupId),
        groupCode: BigInt(groupId),
      },
      fileEntry: {
        fileSize: BigInt(Math.max(0, fileSize)),
        md5,
        md5S2: md5,
        checkKey,
        fileId,
        uploadKey,
      },
      clientInfo: {
        clientType: 3,
        appId: '100',
        terminalType: 3,
        clientVer: '1.1.1',
        unknown: 4,
      },
      fileNameInfo: {
        fileName,
      },
      host: {
        hosts: [
          {
            url: {
              host: uploadHost,
              unknown: 1,
            },
            port: uploadPort,
          },
        ],
      },
    },
    unknown200: 0,
  }, FileUploadExtSchema);
}

function buildPrivateFileUploadExt(
  senderUin: number,
  fileName: string,
  fileSize: number,
  md5: Uint8Array,
  sha1: Uint8Array,
  fileId: string,
  uploadKey: Uint8Array,
  uploadHost: string,
  uploadPort: number,
): Uint8Array {
  return protoEncode({
    unknown1: 100,
    unknown2: 1,
    entry: {
      busiBuff: {
        busId: 102,
        senderUin: BigInt(senderUin),
        receiverUin: 0n,
        groupCode: 0n,
      },
      fileEntry: {
        fileSize: BigInt(Math.max(0, fileSize)),
        md5,
        md5S2: md5,
        checkKey: sha1,
        fileId,
        uploadKey,
      },
      clientInfo: {
        clientType: 3,
        appId: '100',
        terminalType: 3,
        clientVer: '1.1.1',
        unknown: 4,
      },
      fileNameInfo: {
        fileName,
      },
      host: {
        hosts: [
          {
            url: {
              host: uploadHost,
              unknown: 1,
            },
            port: uploadPort,
          },
        ],
      },
    },
    unknown3: 0,
    unknown200: 1,
  }, FileUploadExtSchema);
}

async function resolveSelfUid(bridge: Bridge): Promise<string> {
  let selfUid = bridge.qqInfo.selfUid;
  if (selfUid) return selfUid;

  const selfUin = toInt(bridge.qqInfo.uin);
  if (selfUin <= 0) {
    throw new Error('self uid is unavailable');
  }
  selfUid = await resolveUserUid(bridge, selfUin);
  return selfUid;
}

function normalizeMediaNode(node: MediaIndexNode): Record<string, unknown> {
  const fileUuid = typeof node.fileUuid === 'string' ? node.fileUuid : '';
  if (!fileUuid) throw new Error('media node fileUuid is required');

  const info = node.info ?? {};
  const type = info.type ?? {};

  return {
    info: {
      fileSize: toInt(info.fileSize),
      fileHash: typeof info.fileHash === 'string' ? info.fileHash : '',
      fileSha1: typeof info.fileSha1 === 'string' ? info.fileSha1 : '',
      fileName: typeof info.fileName === 'string' ? info.fileName : '',
      type: {
        type: toInt(type.type),
        picFormat: toInt(type.picFormat),
        videoFormat: toInt(type.videoFormat),
        voiceFormat: toInt(type.voiceFormat),
      },
      width: toInt(info.width),
      height: toInt(info.height),
      time: toInt(info.time),
      original: toInt(info.original),
    },
    fileUuid,
    storeId: toInt(node.storeId),
    uploadTime: toInt(node.uploadTime),
    ttl: toInt(node.ttl),
    subType: toInt(node.subType),
  };
}

async function fetchNtv2DownloadUrl(
  bridge: Bridge,
  serviceCmd: string,
  oidbCmd: number,
  payload: Record<string, unknown>,
): Promise<string> {
  const resp = await sendOidbAndDecode<any>(
    bridge,
    serviceCmd,
    oidbCmd,
    200,
    payload,
    NTV2RichMediaReqSchema,
    NTV2RichMediaRespSchema,
    true,
  );

  ensureRetCodeZero('ntv2 download', resp?.respHead?.retCode, resp?.respHead?.message, undefined);
  const domain = typeof resp?.download?.info?.domain === 'string' ? resp.download.info.domain : '';
  const path = typeof resp?.download?.info?.urlPath === 'string' ? resp.download.info.urlPath : '';
  const rKeyParam = typeof resp?.download?.rKeyParam === 'string' ? resp.download.rKeyParam : '';

  if (!domain || !path) {
    throw new Error('ntv2 download response invalid');
  }
  return `https://${domain}${path}${rKeyParam}`;
}

async function buildForwardPushBody(
  bridge: Bridge,
  node: ForwardNodePayload,
): Promise<Record<string, unknown>> {
  const fromUin = node.userUin > 0 ? node.userUin : toInt(bridge.qqInfo.uin);
  if (fromUin <= 0) throw new Error('forward node user uin is invalid');

  const nickname = node.nickname.trim() || String(fromUin);
  const elems = await buildSendElems(node.elements);
  const now = Math.floor(Date.now() / 1000);
  const random = Math.floor(Math.random() * 0x7fffffff) >>> 0;
  const seq = Math.floor(Math.random() * 9000000) + 1000000;

  return {
    responseHead: {
      fromUin,
      toUid: bridge.qqInfo.selfUid ?? '',
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

// ---------------------------------------------------------------------------
// Friend actions
// ---------------------------------------------------------------------------

export async function setFriendRemark(bridge: Bridge, userId: number, remark: string): Promise<void> {
  const uid = await resolveUserUid(bridge, userId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0xb6e_2', 0xB6E, 2,
    { targetUid: uid, remark }, OidbSetFriendRemarkSchema);
}

export async function setGroupRemark(bridge: Bridge, groupId: number, remark: string): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0xf16_1', 0xF16, 1,
    { inner: { groupId: BigInt(groupId), remark }, field12: 0 }, Oidb0xf16ReqSchema);
}

// ---------------------------------------------------------------------------
// Group file count
// ---------------------------------------------------------------------------

export async function fetchGroupFileCount(bridge: Bridge, groupId: number): Promise<{ fileCount: number; maxCount: number }> {
  const resp = await sendOidbAndDecode<any>(bridge,
    'OidbSvcTrpcTcp.0x6d8_3', 0x6D8, 3,
    { count: { groupUin: groupId, appId: 7, busId: 0 } },
    OidbGroupFileCountViewReqSchema,
    OidbGroupFileCountViewRespSchema);
  return {
    fileCount: toInt(resp?.count?.fileCount ?? 0),
    maxCount: toInt(resp?.count?.maxCount ?? 10000),
  };
}

// ---------------------------------------------------------------------------
// Group admin actions
// ---------------------------------------------------------------------------

export async function muteGroupMember(bridge: Bridge, groupId: number, userId: number, duration: number): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x1253_1', 0x1253, 1,
    { groupUin: groupId, type: 1, body: { targetUid: uid, duration } }, OidbMuteMemberSchema);
}

export async function muteGroupAll(bridge: Bridge, groupId: number, enable: boolean): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x89a_0', 0x89A, 0,
    { groupUin: groupId, muteState: { state: enable ? 0xFFFFFFFF : 0 } }, OidbMuteAllSchema);
}

export async function setGroupAddOption(bridge: Bridge, groupId: number, addType: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x89a_0', 0x89A, 0,
    { groupUin: BigInt(groupId), settings: { addType }, field12: 0 }, Oidb0x89a_0AddOptionSchema);
}

export async function setGroupSearch(bridge: Bridge, groupId: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x89a_0', 0x89A, 0,
    { groupUin: BigInt(groupId), settings: new Uint8Array(0), field12: 0 }, Oidb0x89a_0SearchSchema);
}

export async function kickGroupMember(bridge: Bridge, groupId: number, userId: number, reject: boolean, reason = ''): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x8a0_1', 0x8A0, 1,
    { groupUin: groupId, targetUid: uid, rejectAddRequest: reject, reason }, OidbKickMemberSchema);
}

export async function kickGroupMembers(bridge: Bridge, groupId: number, userIds: number[], reject: boolean): Promise<void> {
  const targetUids = await Promise.all(userIds.map(userId => resolveUserUid(bridge, userId, groupId)));
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x8a0_1', 0x8A0, 1,
    { groupId: BigInt(groupId), targetUids, rejectAddRequest: reject ? 1 : 0, kickReason: new Uint8Array(0), field12: 0 }, Oidb0x8a0ReqSchema);
}

export async function leaveGroup(bridge: Bridge, groupId: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x1097_1', 0x1097, 1,
    { groupUin: groupId }, OidbLeaveGroupSchema);
}

export async function setGroupAdmin(bridge: Bridge, groupId: number, userId: number, enable: boolean): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x1096_1', 0x1096, 1,
    { groupUin: groupId, uid, isAdmin: enable }, OidbSetAdminSchema);
}

export async function setGroupCard(bridge: Bridge, groupId: number, userId: number, card: string): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x8fc_3', 0x8FC, 3,
    { groupUin: groupId, body: { targetUid: uid, targetName: card } }, OidbRenameMemberSchema);
}

export async function setGroupName(bridge: Bridge, groupId: number, name: string): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x89a_15', 0x89A, 15,
    { groupUin: groupId, body: { targetName: name } }, OidbRenameGroupSchema);
}

export async function setGroupSpecialTitle(bridge: Bridge, groupId: number, userId: number, title: string): Promise<void> {
  const uid = await resolveUserUid(bridge, userId, groupId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x8fc_2', 0x8FC, 2,
    { groupUin: groupId, body: { targetUid: uid, specialTitle: title, expireTime: -1 } }, OidbSpecialTitleSchema);
}

// ---------------------------------------------------------------------------
// Friend / group add requests
// ---------------------------------------------------------------------------

export async function setFriendAddRequest(bridge: Bridge, uidOrFlag: string, approve: boolean): Promise<void> {
  let targetUid = uidOrFlag;
  if (/^\d+$/.test(uidOrFlag)) {
    targetUid = await resolveUserUid(bridge, parseInt(uidOrFlag, 10));
  }
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0xb5d_44', 0xB5D, 44,
    { accept: approve ? 3 : 5, targetUid }, OidbFriendRequestActionSchema);
}

export async function deleteFriend(bridge: Bridge, userId: number, block = false): Promise<void> {
  const targetUid = await resolveUserUid(bridge, userId);
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x126b_0', 0x126B, 0,
    {
      field1: {
        targetUid,
        field2: {
          field1: 130,
          field2: 109,
          field3: {
            field1: 8,
            field2: 8,
            field3: 50,
          },
        },
        block,
        field4: false,
      },
    },
    OidbDeleteFriendSchema);

  // Refresh friend cache after deletion.
  try { await bridge.fetchFriendList(); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Group / private file operations
// ---------------------------------------------------------------------------

export async function uploadGroupFile(
  bridge: Bridge,
  groupId: number,
  source: string,
  name = '',
  folderId = '/',
  uploadFile = true,
): Promise<UploadFileResult> {
  const loaded = await loadBinarySource(source, 'file');
  if (!loaded.bytes.length) throw new Error('group file is empty');

  const fileName = normalizeUploadFileName(name, loaded.fileName);
  const hashes = computeHashes(loaded.bytes);

  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0x6d6_0',
    0x6D6,
    0,
    {
      file: {
        groupUin: groupId,
        appId: 4,
        busId: 102,
        entrance: 6,
        targetDirectory: normalizeDirectory(folderId),
        fileName,
        localDirectory: `/${fileName}`,
        fileSize: BigInt(loaded.bytes.length),
        fileSha1: hashes.sha1,
        fileSha3: new Uint8Array(0),
        fileMd5: hashes.md5,
        field15: true,
      },
    },
    OidbGroupFileReqSchema,
    OidbGroupFileRespSchema,
    true,
  );

  const upload = resp?.upload;
  if (!upload) throw new Error('group file upload response missing');
  ensureRetCodeZero('group file upload', upload.retCode, upload.retMsg, upload.clientWording);

  const fileId = typeof upload.fileId === 'string' && upload.fileId ? upload.fileId : null;
  if (!fileId) throw new Error('group file upload response missing file_id');

  if (!upload.boolFileExist && uploadFile) {
    const senderUin = toInt(bridge.qqInfo.uin);
    if (senderUin <= 0) throw new Error('invalid self uin for group file upload');

    const uploadHost = (typeof upload.uploadIp === 'string' && upload.uploadIp)
      || (typeof upload.serverDns === 'string' && upload.serverDns)
      || '';
    const uploadPort = toInt(upload.uploadPort);
    if (!uploadHost || uploadPort <= 0) {
      throw new Error('group file upload host is invalid');
    }

    const ext = buildGroupFileUploadExt(
      senderUin,
      groupId,
      fileName,
      loaded.bytes.length,
      hashes.md5,
      fileId,
      upload.fileKey instanceof Uint8Array ? upload.fileKey : new Uint8Array(0),
      upload.checkKey instanceof Uint8Array ? upload.checkKey : new Uint8Array(0),
      uploadHost,
      uploadPort,
    );

    const session = await fetchHighwaySession(bridge);
    await uploadHighwayHttp(bridge, session, 71, loaded.bytes, hashes.md5, ext);
  }

  return { fileId };
}

export async function uploadPrivateFile(
  bridge: Bridge,
  userId: number,
  source: string,
  name = '',
  uploadFile = true,
): Promise<UploadFileResult> {
  const loaded = await loadBinarySource(source, 'file');
  if (!loaded.bytes.length) throw new Error('private file is empty');

  const targetUid = await resolveUserUid(bridge, userId);
  let selfUid = bridge.qqInfo.selfUid;
  if (!selfUid) {
    const selfUin = toInt(bridge.qqInfo.uin);
    if (selfUin > 0) {
      selfUid = await resolveUserUid(bridge, selfUin);
    }
  }
  if (!selfUid) throw new Error('self uid is unavailable');

  const senderUin = toInt(bridge.qqInfo.uin);
  if (senderUin <= 0) throw new Error('invalid self uin for private file upload');

  const fileName = normalizeUploadFileName(name, loaded.fileName);
  const hashes = computeHashes(loaded.bytes);

  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0xe37_1700',
    0xE37,
    1700,
    {
      command: 1700,
      seq: 0,
      upload: {
        senderUid: selfUid,
        receiverUid: targetUid,
        fileSize: loaded.bytes.length,
        fileName,
        md510MCheckSum: md5First10MB(loaded.bytes),
        sha1CheckSum: hashes.sha1,
        localPath: '/',
        md5CheckSum: hashes.md5,
        sha3CheckSum: new Uint8Array(0),
      },
      businessId: 3,
      clientType: 1,
      flagSupportMediaPlatform: 1,
    },
    OidbPrivateFileUploadReqSchema,
    OidbPrivateFileUploadRespSchema,
  );

  const upload = resp?.upload;
  if (!upload) throw new Error('private file upload response missing');
  ensureRetCodeZero('private file upload', upload.retCode, upload.retMsg, undefined);

  const fileId = typeof upload.uuid === 'string' && upload.uuid ? upload.uuid : null;
  const fileHash = typeof upload.fileAddon === 'string' && upload.fileAddon ? upload.fileAddon : null;
  if (!fileId) throw new Error('private file upload response missing file_id');

  if (!upload.boolFileExist && uploadFile) {
    const uploadHost = (typeof upload.uploadIp === 'string' && upload.uploadIp)
      || '';
    const uploadPort = toInt(upload.uploadPort);
    if (!uploadHost || uploadPort <= 0) {
      throw new Error('private file upload host is invalid');
    }

    const ext = buildPrivateFileUploadExt(
      senderUin,
      fileName,
      loaded.bytes.length,
      hashes.md5,
      hashes.sha1,
      fileId,
      upload.mediaPlatformUploadKey instanceof Uint8Array
        ? upload.mediaPlatformUploadKey
        : (upload.uploadKey instanceof Uint8Array ? upload.uploadKey : new Uint8Array(0)),
      uploadHost,
      uploadPort,
    );

    const session = await fetchHighwaySession(bridge);
    await uploadHighwayHttp(bridge, session, 95, loaded.bytes, hashes.md5, ext);
  }

  return { fileId, fileHash };
}

export async function fetchGroupFiles(bridge: Bridge, groupId: number, folderId = '/'): Promise<GroupFilesResult> {
  const targetDirectory = normalizeDirectory(folderId);
  const files: GroupFileInfo[] = [];
  const folders: GroupFolderInfo[] = [];

  const pageSize = 20;
  let startIndex = 0;
  for (let page = 0; page < 200; page++) {
    const resp = await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0x6d8_1',
      0x6D8,
      1,
      {
        list: {
          groupUin: groupId,
          appId: 7,
          targetDirectory,
          fileCount: pageSize,
          sortBy: 1,
          startIndex,
          field17: 2,
          field18: 0,
        },
      },
      OidbGroupFileViewReqSchema,
      OidbGroupFileViewRespSchema,
      true,
    );

    const list = resp?.list;
    if (!list) break;
    ensureRetCodeZero('group file list', list.retCode, list.retMsg, list.clientWording);

    for (const item of list.items ?? []) {
      const type = toInt(item?.type);
      if (type === 1 && item?.fileInfo) {
        const file = item.fileInfo;
        const uploader = toInt(file.uploaderUin);
        const cached = bridge.qqInfo.findGroupMember(groupId, uploader);
        files.push({
          fileId: typeof file.fileId === 'string' ? file.fileId : '',
          fileName: typeof file.fileName === 'string' ? file.fileName : '',
          busId: toInt(file.busId),
          fileSize: toInt(file.fileSize),
          uploadTime: toInt(file.uploadedTime),
          deadTime: toInt(file.expireTime),
          modifyTime: toInt(file.modifiedTime),
          downloadTimes: toInt(file.downloadedTimes),
          uploader,
          uploaderName: (typeof file.uploaderName === 'string' && file.uploaderName)
            || cached?.card
            || cached?.nickname
            || '',
        });
      } else if (type === 2 && item?.folderInfo) {
        const folder = item.folderInfo;
        const creator = toInt(folder.creatorUin);
        const cached = bridge.qqInfo.findGroupMember(groupId, creator);
        folders.push({
          folderId: typeof folder.folderId === 'string' ? folder.folderId : '',
          folderName: typeof folder.folderName === 'string' ? folder.folderName : '',
          createTime: toInt(folder.createTime),
          creator,
          creatorName: (typeof folder.creatorName === 'string' && folder.creatorName)
            || cached?.card
            || cached?.nickname
            || '',
          totalFileCount: toInt(folder.totalFileCount),
        });
      }
    }

    if (list.isEnd) break;
    startIndex += pageSize;
  }

  return { files, folders };
}

export async function fetchGroupFileUrl(bridge: Bridge, groupId: number, fileId: string, busId = 102): Promise<string> {
  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0x6d6_2',
    0x6D6,
    2,
    {
      download: {
        groupUin: groupId,
        appId: 7,
        busId,
        fileId,
      },
    },
    OidbGroupFileReqSchema,
    OidbGroupFileRespSchema,
    true,
  );

  const download = resp?.download;
  if (!download) throw new Error('group file url response missing');
  ensureRetCodeZero('group file url', download.retCode, download.retMsg, download.clientWording);

  const dns = (typeof download.downloadDns === 'string' && download.downloadDns)
    || (typeof download.downloadIp === 'string' && download.downloadIp)
    || '';
  const hexUrl = bytesToHexUpper(download.downloadUrl);
  if (!dns || !hexUrl) {
    throw new Error('group file url response invalid');
  }

  // Keep the same behavior as Lagrange: append file_id after ?fname=
  return `https://${dns}/ftn_handler/${hexUrl}/?fname=${fileId}`;
}

export async function deleteGroupFile(bridge: Bridge, groupId: number, fileId: string): Promise<void> {
  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0x6d6_3',
    0x6D6,
    3,
    {
      delete: {
        groupUin: groupId,
        busId: 102,
        fileId,
      },
    },
    OidbGroupFileReqSchema,
    OidbGroupFileRespSchema,
    true,
  );

  const result = resp?.delete;
  if (!result) throw new Error('group file delete response missing');
  ensureRetCodeZero('group file delete', result.retCode, result.retMsg, result.clientWording);
}

export async function moveGroupFile(
  bridge: Bridge,
  groupId: number,
  fileId: string,
  parentDirectory: string,
  targetDirectory: string,
): Promise<void> {
  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0x6d6_5',
    0x6D6,
    5,
    {
      move: {
        groupUin: groupId,
        appId: 7,
        busId: 102,
        fileId,
        parentDirectory,
        targetDirectory,
      },
    },
    OidbGroupFileReqSchema,
    OidbGroupFileRespSchema,
    true,
  );

  const result = resp?.move;
  if (!result) throw new Error('group file move response missing');
  ensureRetCodeZero('group file move', result.retCode, result.retMsg, result.clientWording);
}

export async function createGroupFileFolder(bridge: Bridge, groupId: number, name: string, parentId = '/'): Promise<void> {
  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0x6d7_0',
    0x6D7,
    0,
    {
      create: {
        groupUin: groupId,
        rootDirectory: normalizeDirectory(parentId),
        folderName: name,
      },
    },
    OidbGroupFileFolderReqSchema,
    OidbGroupFileFolderRespSchema,
    true,
  );

  const result = resp?.create;
  if (!result) throw new Error('group folder create response missing');
  ensureRetCodeZero('group folder create', result.retcode, result.retMsg, result.clientWording);
}

export async function deleteGroupFileFolder(bridge: Bridge, groupId: number, folderId: string): Promise<void> {
  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0x6d7_1',
    0x6D7,
    1,
    {
      delete: {
        groupUin: groupId,
        folderId,
      },
    },
    OidbGroupFileFolderReqSchema,
    OidbGroupFileFolderRespSchema,
    true,
  );

  const result = resp?.delete;
  if (!result) throw new Error('group folder delete response missing');
  ensureRetCodeZero('group folder delete', result.retcode, result.retMsg, result.clientWording);
}

export async function renameGroupFileFolder(bridge: Bridge, groupId: number, folderId: string, newFolderName: string): Promise<void> {
  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0x6d7_2',
    0x6D7,
    2,
    {
      rename: {
        groupUin: groupId,
        folderId,
        newFolderName,
      },
    },
    OidbGroupFileFolderReqSchema,
    OidbGroupFileFolderRespSchema,
    true,
  );

  const result = resp?.rename;
  if (!result) throw new Error('group folder rename response missing');
  ensureRetCodeZero('group folder rename', result.retcode, result.retMsg, result.clientWording);
}

export async function fetchPrivateFileUrl(bridge: Bridge, userId: number, fileId: string, fileHash: string): Promise<string> {
  const uid = await resolveUserUid(bridge, userId);
  const resp = await sendOidbAndDecode<any>(
    bridge,
    'OidbSvcTrpcTcp.0xe37_1200',
    0xE37,
    1200,
    {
      subCommand: 1200,
      field2: 1,
      body: {
        receiverUid: uid,
        fileUuid: fileId,
        type: 2,
        fileHash,
        t2: 0,
      },
      field101: 3,
      field102: 103,
      field200: 1,
      field99999: new Uint8Array([0xC0, 0x85, 0x2C, 0x01]),
    },
    OidbPrivateFileDownloadReqSchema,
    OidbPrivateFileDownloadRespSchema,
  );

  const result = resp?.body?.result;
  const server = typeof result?.server === 'string' ? result.server : '';
  const port = toInt(result?.port);
  const url = typeof result?.url === 'string' ? result.url : '';
  if (!server || !port || !url) {
    throw new Error('private file url response invalid');
  }
  return `http://${server}:${port}${url}&isthumb=0`;
}

export async function fetchGroupPttUrlByNode(bridge: Bridge, groupId: number, node: MediaIndexNode): Promise<string> {
  const normalizedNode = normalizeMediaNode(node);
  return fetchNtv2DownloadUrl(bridge, 'OidbSvcTrpcTcp.0x126e_200', 0x126E, {
    reqHead: {
      common: { requestId: 4, command: 200 },
      scene: {
        requestType: 1,
        businessType: 3,
        sceneType: 2,
        group: { groupUin: groupId },
      },
      client: { agentType: 2 },
    },
    download: {
      node: normalizedNode,
      download: { video: { busiType: 0, sceneType: 0 } },
    },
  });
}

export async function fetchPrivatePttUrlByNode(bridge: Bridge, node: MediaIndexNode): Promise<string> {
  const selfUid = await resolveSelfUid(bridge);
  const normalizedNode = normalizeMediaNode(node);
  return fetchNtv2DownloadUrl(bridge, 'OidbSvcTrpcTcp.0x126d_200', 0x126D, {
    reqHead: {
      common: { requestId: 1, command: 200 },
      scene: {
        requestType: 1,
        businessType: 3,
        sceneType: 1,
        c2c: {
          accountType: 2,
          targetUid: selfUid,
        },
      },
      client: { agentType: 2 },
    },
    download: {
      node: normalizedNode,
      download: { video: { busiType: 0, sceneType: 0 } },
    },
  });
}

export async function fetchGroupVideoUrlByNode(bridge: Bridge, groupId: number, node: MediaIndexNode): Promise<string> {
  const normalizedNode = normalizeMediaNode(node);
  return fetchNtv2DownloadUrl(bridge, 'OidbSvcTrpcTcp.0x11ea_200', 0x11EA, {
    reqHead: {
      common: { requestId: 1, command: 200 },
      scene: {
        requestType: 2,
        businessType: 2,
        sceneType: 2,
        group: { groupUin: groupId },
      },
      client: { agentType: 2 },
    },
    download: {
      node: normalizedNode,
      download: { video: { busiType: 0, sceneType: 0 } },
    },
  });
}

export async function fetchPrivateVideoUrlByNode(bridge: Bridge, node: MediaIndexNode): Promise<string> {
  const selfUid = await resolveSelfUid(bridge);
  const normalizedNode = normalizeMediaNode(node);
  return fetchNtv2DownloadUrl(bridge, 'OidbSvcTrpcTcp.0x11e9_200', 0x11E9, {
    reqHead: {
      common: { requestId: 1, command: 200 },
      scene: {
        requestType: 2,
        businessType: 2,
        sceneType: 1,
        c2c: {
          accountType: 2,
          targetUid: selfUid,
        },
      },
      client: { agentType: 2 },
    },
    download: {
      node: normalizedNode,
      download: { video: { busiType: 0, sceneType: 0 } },
    },
  });
}

export async function uploadForwardNodes(bridge: Bridge, nodes: ForwardNodePayload[], groupId?: number): Promise<string> {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('forward nodes are required');
  }

  const msgBody = await Promise.all(nodes.map(node => buildForwardPushBody(bridge, node)));
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
  })));

  return resId;
}

export async function fetchForwardNodes(bridge: Bridge, resId: string): Promise<ForwardNodePayload[]> {
  const cached = forwardResCache.get(resId);
  if (cached) {
    return cached.map(node => ({ userUin: node.userUin, nickname: node.nickname, elements: [...node.elements] }));
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
      uin: bridge.qqInfo.uin,
      serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
      seqId: 0,
      retCode: 0,
      fromClient: false,
      body: wrapped,
    };
    const events = parseMsgPush(pkt, bridge.qqInfo);
    const event = events.find(e =>
      e.kind === 'friend_message' || e.kind === 'group_message' || e.kind === 'temp_message');
    if (!event) continue;

    if (event.kind === 'group_message') {
      nodes.push({
        userUin: event.senderUin,
        nickname: event.senderCard || event.senderNick,
        elements: event.elements,
      });
    } else if (event.kind === 'friend_message') {
      nodes.push({
        userUin: event.senderUin,
        nickname: event.senderNick,
        elements: event.elements,
      });
    } else {
      nodes.push({
        userUin: event.senderUin,
        nickname: event.senderNick,
        elements: event.elements,
      });
    }
  }

  if (nodes.length > 0) {
    forwardResCache.set(resId, nodes.map(node => ({ userUin: node.userUin, nickname: node.nickname, elements: [...node.elements] })));
  }
  return nodes;
}

export async function setGroupAddRequest(
  bridge: Bridge, groupId: number, sequence: number, eventType: number,
  approve: boolean, reason = '', filtered = false,
): Promise<void> {
  const subCmd = filtered ? 2 : 1;
  const cmd = filtered ? 'OidbSvcTrpcTcp.0x10c8_2' : 'OidbSvcTrpcTcp.0x10c8_1';
  await sendOidbAndCheck(bridge, cmd, 0x10C8, subCmd,
    { accept: approve ? 1 : 2, body: { sequence: BigInt(sequence), eventType, groupUin: groupId, message: reason } },
    OidbGroupRequestActionSchema, true);
}

// ---------------------------------------------------------------------------
// Poke / Like
// ---------------------------------------------------------------------------

export async function sendPoke(bridge: Bridge, isGroup: boolean, peerUin: number, targetUin?: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0xed3_1', 0xED3, 1,
    {
      uin: targetUin ?? peerUin,
      groupUin: isGroup ? peerUin : 0,
      friendUin: isGroup ? 0 : peerUin,
      ext: 0,
    }, OidbPokeSchema);
}

export async function sendLike(bridge: Bridge, userId: number, count: number): Promise<void> {
  await sendOidbAndCheck(bridge, 'OidbSvcTrpcTcp.0x7e5_104', 0x7E5, 104,
    { targetUin: userId, count }, OidbLikeSchema);
}

// ---------------------------------------------------------------------------
// Essence / Reaction
// ---------------------------------------------------------------------------

export async function setGroupEssence(bridge: Bridge, groupId: number, sequence: number, random: number, enable: boolean): Promise<void> {
  const subCmd = enable ? 1 : 2;
  const cmd = enable ? 'OidbSvcTrpcTcp.0xeac_1' : 'OidbSvcTrpcTcp.0xeac_2';
  await sendOidbAndCheck(bridge, cmd, 0xEAC, subCmd,
    { groupUin: groupId, sequence, random }, OidbEssenceSchema);
}

export async function setGroupReaction(bridge: Bridge, groupId: number, sequence: number, code: string, isSet: boolean): Promise<void> {
  const subCmd = isSet ? 1 : 2;
  const cmd = isSet ? 'OidbSvcTrpcTcp.0x9082_1' : 'OidbSvcTrpcTcp.0x9082_2';
  await sendOidbAndCheck(bridge, cmd, 0x9082, subCmd,
    { groupUin: groupId, sequence, code }, OidbGroupReactionSchema);
}

// ---------------------------------------------------------------------------
// Recall messages
// ---------------------------------------------------------------------------

export async function recallGroupMessage(bridge: Bridge, groupId: number, sequence: number): Promise<void> {
  const request = protoEncode({
    type: 1,
    groupUin: groupId,
    info: { sequence, random: 0, field3: 0 },
    settings: { field1: 0 },
  }, GroupRecallRequestSchema);
  const result = await bridge.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg', request);
  if (!result.success) throw new Error(result.errorMessage || 'recall group message failed');
}

export async function recallPrivateMessage(
  bridge: Bridge, userUin: number, clientSeq: number,
  msgSeq: number, random: number, timestamp: number,
): Promise<void> {
  const targetUid = await resolveUserUid(bridge, userUin);
  const request = protoEncode({
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
  }, C2CRecallRequestSchema);
  const result = await bridge.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg', request);
  if (!result.success) throw new Error(result.errorMessage || 'recall private message failed');
}

// --- Mark message as read ---

export async function markPrivateMessageRead(
    bridge: Bridge,
    userId: number,
    msgSeq: number,
    timestamp: number = Math.floor(Date.now() / 1000)
): Promise<void> {
  const uid = await resolveUserUid(bridge, userId);

  const request = protoEncode({
    c2cList: [
      {
        uid,
        lastReadTime: BigInt(timestamp),
        lastReadSeq: BigInt(msgSeq),
      }
    ]
  }, SsoReadedReportReqSchema);

  const result = await bridge.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoReadedReport', request);

  if (!result.success) {
    throw new Error(result.errorMessage || 'mark private message read failed');
  }
}

export async function markGroupMessageRead(
    bridge: Bridge,
    groupId: number,
    msgSeq: number
): Promise<void> {
  const request = protoEncode({
    groupList: [
      {
        groupUin: BigInt(groupId),
        lastReadSeq: BigInt(msgSeq),
      }
    ]
  }, SsoReadedReportReqSchema);

  const result = await bridge.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoReadedReport', request);

  if (!result.success) {
    throw new Error(result.errorMessage || 'mark group message read failed');
  }
}

export async function setOnlineStatus(
    bridge: Bridge,
    status: number,
    extStatus: number = 0,
    batteryStatus: number = 100
): Promise<void> {
  const request = protoEncode({
    status,
    extStatus,
    batteryStatus,
  }, SetStatusReqSchema);

  const result = await bridge.sendRawPacket('trpc.qq_new_tech.status_svc.StatusService.SetStatus', request);

  if (!result.success) {
    throw new Error(result.errorMessage || 'set online status failed (network/timeout)');
  }

  if (result.responseData && result.responseData.length > 0) {
    const resp = protoDecode(result.responseData, SetStatusRespSchema);
    if (!resp) {
      throw new Error(result.errorMessage || 'set online status failed (network/timeout)');
    }
    if (resp.errCode !== undefined && resp.errCode !== 0) {
      throw new Error(resp.errMsg || `set online status failed with errCode: ${resp.errCode}`);
    }
  }
}

export async function setProfile(
    bridge: Bridge,
    nickname?: string,
    personalNote?: string
): Promise<void> {
  const uin = BigInt(bridge.qqInfo.uin);
  const stringProfiles: any[] = [];
  const intProfiles: any[] = [];

  if (nickname !== undefined) {
    stringProfiles.push({ fieldId: 20002, value: nickname });
  }

  if (personalNote !== undefined) {
    stringProfiles.push({ fieldId: 102, value: personalNote });
  }

  if (stringProfiles.length === 0 && intProfiles.length === 0) {
    return;
  }

  const req = {
    uin,
    stringProfiles,
  };

  await sendOidbAndCheck(
      bridge,
      'OidbSvcTrpcTcp.0x112a_2',
      0x112A,
      2,
      req,
      OidbSetProfileSchema
  );
}


export async function getProfileLike(
    bridge: Bridge,
    userId?: number,
    start: number = 0,
    limit: number = 10
) {

  // const isSelf = !userId || userId === bridge.qqInfo.uin;
  // const targetUid = isSelf
  //     ? bridge.qqInfo.uid
  //     : await bridge.getUidByUinV2(userId!);


  const isSelf = !userId
  const targetUid = isSelf
      ? await resolveSelfUid(bridge)
      : await resolveUserUid(bridge, userId)

  if (!targetUid) {
    throw new Error('target uid not found');
  }

  const req = {
    targetUid: targetUid,
    basic: 1,
    vote: 1,
    favorite: 1,
    start: start,
    limit: limit,
  };

  const result = await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0x7ed_12',
      0x7ED,
      12,
      req,
      Oidb0x7edReqSchema,
      Oidb0x7edRespSchema
  );

  const data = result?.userLikeInfos?.[0];
  if (!data) {
    throw new Error('get profile like info empty');
  }

  return {
    uid: data.uid,
    time: Number(data.time),
    favoriteInfo: {
      total_count: data.favoriteInfo?.totalCount || 0,
      last_time: Number(data.favoriteInfo?.lastTime || 0),
      today_count: data.favoriteInfo?.newCount || 0,
      userInfos: []
    },
    voteInfo: {
      total_count: data.voteInfo?.totalCount || 0,
      new_count: data.voteInfo?.newCount || 0,
      new_nearby_count: 0,
      last_visit_time: Number(data.voteInfo?.lastTime || 0),
      userInfos: []
    }
  };
}

export async function getGroupAtAllRemain(
    bridge: Bridge,
    groupId: number
) {
  const req = {
    basic1: 1,
    basic2: 2,
    basic3: 1,
    uin: BigInt(bridge.qqInfo.uin),
    groupId: BigInt(groupId),
    type: 0,
  };

  const result = await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0x8a7_0',
      0x8A7,
      0,
      req,
      Oidb0x8a7ReqSchema,
      Oidb0x8a7RespSchema
  );

  if (!result) {
    throw new Error('get group at all remain result empty');
  }

  return {
    can_at_all: !!result.canAtAll,
    remain_at_all_count_for_group: Number(result.groupRemain || 0), // 【修改点】：防止底层库将 uint32 也返回成 BigInt 导致无法被 JSON 序列化
    remain_at_all_count_for_uin: Number(result.uinRemain || 0)      // 【修改点】：同上
  };
}

export async function getUnidirectionalFriendList(
    bridge: Bridge
) {
  const reqObj = {
    uint64_uin: String(bridge.qqInfo.uin),
    uint64_top: 0,
    uint32_req_num: 99,
    bytes_cookies: ""
  };

  const req = {
    jsonBody: JSON.stringify(reqObj)
  };

  const result = await sendOidbAndDecode<any>(
      bridge,
      'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0',
      0xE17,
      0,
      req,
      Oidb0xe17ReqSchema,
      Oidb0xe17RespSchema
  );

  if (!result || !result.jsonBody) {
    throw new Error('get unidirectional friend list empty');
  }

  const parsed = JSON.parse(result.jsonBody);
  return parsed.rpt_block_list || [];
}

export async function setSelfLongNick(
    bridge: Bridge,
    longNick: string
) {
  const req = {
    uin: BigInt(bridge.qqInfo.uin),
    profile: {
      tag: 102,
      value: String(longNick)
    }
  };

  await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0x112a_2',
      0x112A,
      2,
      req,
      Oidb0x112aReqSchema,
      Oidb0x112aRespSchema
  );
}

export async function setInputStatus(
    bridge: Bridge,
    userId: number,
    eventType: number
) {
  const targetUid = await resolveUserUid(bridge, userId);

  if (!targetUid) {
    throw new Error('target uid not found');
  }

  const req = {
    reqBody: {
      uid: targetUid,
      chatType: 0,
      eventType: eventType
    }
  };

  await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0xcd4_1',
      0xCD4,
      1,
      req,
      Oidb0xcd4ReqSchema,
      Oidb0xcd4RespSchema
  );
}

export async function translateEn2Zh(
    bridge: Bridge,
    words: string[]
) {
  const req = {
    translateReq: {
      srcLang: 'en',
      dstLang: 'zh',
      words: words
    },
    tag10: 1,
    tag12: 1
  };

  const result = await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0x990_2',
      0x990,
      2,
      req,
      Oidb0x990ReqSchema,
      Oidb0x990RespSchema
  );

  const resp = result?.translateResp;
  if (!resp) {
    throw new Error('translate response empty');
  }

  return resp.dstWords || [];
}

export async function getMiniAppArk(
    bridge: Bridge,
    type: string,
    title: string,
    desc: string,
    picUrl: string,
    jumpUrl: string
) {
  let appid = "1109937557"; // 默认 bili
  let iconUrl = "http://miniapp.gtimg.cn/public/appicon/51f90239b78a2e4994c11215f4c4ba15_200.jpg";

  if (type === 'weibo') {
    appid = "1109224783";
    iconUrl = "http://miniapp.gtimg.cn/public/appicon/35bbb44dc68e65194cfacfb206b8f1f7_200.jpg";
  } else if (type !== 'bili') {
    throw new Error(`unsupported type: ${type}, only support bili and weibo`);
  }

  const request = protoEncode({
    sdkVersion: "V1_PC_MINISDK_99.99.99_1_APP_A",
    body: {
      appid,
      title,
      desc,
      picUrl,
      jumpUrl,
      iconUrl
    }
  }, MiniAppShareReqSchema);

  const result = await bridge.sendRawPacket('LightAppSvc.mini_app_share.AdaptShareInfo', request);

  if (!result.success || !result.responseData) {
    throw new Error(result.errorMessage || 'get mini app ark failed');
  }

  const decoded = protoDecode(result.responseData, MiniAppShareRespSchema);
  const jsonStr = decoded?.body?.jsonStr;

  if (!jsonStr) {
    throw new Error('mini app share json empty');
  }

  const parsed = JSON.parse(jsonStr);

  return {
    data: {
      ver: parsed.ver,
      prompt: parsed.prompt,
      config: parsed.config,
      app: parsed.appName,
      view: parsed.appView,
      meta: parsed.metaData,
      miniappShareOrigin: 3,
      miniappOpenRefer: "10002"
    }
  };
}

export async function clickInlineKeyboardButton(
    bridge: Bridge,
    groupId: number,
    botAppid: number,
    buttonId: string,
    callbackData: string,
    msgSeq: number
) {
  const req = {
    botAppid: BigInt(botAppid),
    msgSeq: BigInt(msgSeq),
    buttonId: String(buttonId),
    callbackData: String(callbackData || ''),
    unknown7: 0,
    groupId: BigInt(groupId),
    unknown9: 1,
  };

  const result = await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0x112e_1',
      0x112E,
      1,
      req,
      Oidb0x112eReqSchema,
      Oidb0x112eRespSchema
  );

  if (!result) {
    throw new Error('click inline keyboard button result empty');
  }

  return {
    result: Number(result.result || 0),
    errMsg: result.errMsg || '',
    status: 0,
    promptText: result.promptText || '',
    promptType: 0,
    promptIcon: 0
  };
}


export async function sendGroupSign(
    bridge: Bridge,
    groupId: number
) {
  const req = {
    signInInfo: {
      uin: String(bridge.qqInfo.uin),
      groupId: String(groupId),
      version: "9.0.90"
    }
  };

  await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0xEB7_1',
      0xEB7,
      1,
      req,
      Oidb0xeb7ReqSchema,
      Oidb0xeb7RespSchema
  );
}

export async function setAvatar(
  bridge: Bridge,
  source: string,
): Promise<void> {
  const loaded = await loadBinarySource(source, 'avatar');
  if (!loaded.bytes.length) throw new Error('avatar file is empty');

  const hashes = computeHashes(loaded.bytes);
  const session = await fetchHighwaySession(bridge);
  await uploadHighwayHttp(bridge, session, 90, loaded.bytes, hashes.md5, new Uint8Array(0));
}

export async function fetchCustomFace(bridge: Bridge, count: number = 10): Promise<string[]> {
  const req = {
    inner: { field1: 1, osVersion: '10.0.26200', qqVersion: '9.9.28-46928' },
    uin: BigInt(bridge.qqInfo.uin),
    field3: 1,
    field6: 1,
  };
  const request = protoEncode(req, FaceroamOpReqSchema);
  const result = await bridge.sendRawPacket('Faceroam.OpReq', request);
  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'fetch custom face failed');
  }
  const resp = protoDecode(result.responseData, FaceroamOpRespSchema);
  if (!resp || (resp as any).retCode !== 0) {
    throw new Error(`fetch custom face error: ${(resp as any)?.message || 'unknown'}`);
  }
  const faceIds = (resp as any).item?.faceIds || [];
  return faceIds.slice(0, count).map((id: string) => `https://p.qpic.cn/qq_expression/${bridge.qqInfo.uin}/${id}/0`);
}

export async function getEmojiLikes(
  bridge: Bridge,
  groupId: number,
  sequence: number,
  emojiId: string,
  emojiType: number = 1,
  count: number = 10,
  cookie: string = ''
): Promise<{ users: Array<{ uin: number }>, cookie: string, isLast: boolean }> {
  const req = {
    groupId: BigInt(groupId),
    sequence,
    emojiType,
    emojiId,
    cookie: cookie ? Buffer.from(cookie, 'base64') : new Uint8Array(0),
    field7: 0,
    count,
    field12: 1,
  };
  const resp = await sendOidbAndDecode<any>(bridge, 'OidbSvcTrpcTcp.0x9083_1', 0x9083, 1, req, Oidb0x9083ReqSchema, Oidb0x9083RespSchema);
  const uin = resp?.inner?.userInfo?.uin;
  const users = uin ? [{ uin: Number(uin) }] : [];
  const respCookie = resp?.cookie ? Buffer.from(resp.cookie).toString('base64') : '';
  return { users, cookie: respCookie, isLast: !respCookie };
}

