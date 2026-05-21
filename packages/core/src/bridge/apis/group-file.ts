// GroupFileApi — group file CRUD + private (c2c) file upload + media
// download URL resolvers. Inlined from `actions/group-file.ts`
// (deleted alongside the rest of actions/* in commit 13).
//
// Naming: methods drop the redundant `Group`/`File` suffix where the
// area name already says it. The `Private`/`Group` axis stays
// explicit because some methods only exist for one side
// (`publish` only makes sense for group, `getPrivateUrl` only for
// c2c) — keeping them in one Api lets the few shared private helpers
// (`fetchNtv2DownloadUrl`, the upload-ext builder) live in one file.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { toHexUpper } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';
import { fetchHighwaySession, uploadHighwayHttp } from '@snowluma/bridge/highway';
import { computeHashes, computeMd5, FILE_UPLOAD_MAX_BYTES, loadBinarySource } from '@snowluma/bridge/highway/utils';
import type { FileUploadExt } from '@snowluma/proto-defs/highway';
import { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileCountViewReq,
  OidbGroupFileCountViewResp,
  OidbGroupFileFolderReq,
  OidbGroupFileFolderResp,
  OidbGroupFileReq,
  OidbGroupFileResp,
  OidbGroupFileViewReq,
  OidbGroupFileViewResp,
  OidbGroupSendFileReq,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type {
  NTV2RichMediaReq,
  NTV2RichMediaResp,
  OidbPrivateFileDownloadReq,
  OidbPrivateFileDownloadResp,
  OidbPrivateFileUploadReq,
  OidbPrivateFileUploadResp,
} from '@snowluma/proto-defs/oidb-actions/media';
import { ensureRetCodeZero, resolveSelfUid, toInt, type MediaIndexNode } from './shared';

const log = createLogger('GroupFile');

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

// ─────────────── public result types ───────────────

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

// Re-export so callers don't have to dig into apis/shared.
export type { MediaIndexNode } from './shared';

// ─────────────── file-specific helpers ───────────────

function normalizeDirectory(dir?: string): string {
  if (!dir || !dir.trim()) return '/';
  return dir;
}

function bytesToHexUpper(data: unknown): string {
  if (!(data instanceof Uint8Array) || data.length === 0) return '';
  return toHexUpper(data);
}

// Reverses acidify's `Int.toIpString()`: the 32-bit IP arrives
// little-endian-packed (byte0 = first dotted octet) and we unpack it the
// same way. Force-unsigned the shift to keep negative ints (high bit set)
// rendering correctly — JS `>>` is arithmetic and would turn 0xFF000000
// into a negative number.
function int32ToIpv4Dotted(value: number): string {
  const b1 = value & 0xFF;
  const b2 = (value >>> 8) & 0xFF;
  const b3 = (value >>> 16) & 0xFF;
  const b4 = (value >>> 24) & 0xFF;
  return `${b1}.${b2}.${b3}.${b4}`;
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
  return protobuf_encode<FileUploadExt>({
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
  });
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
  return protobuf_encode<FileUploadExt>({
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
  });
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
  const env = makeOidbEnvelope<NTV2RichMediaReq>(oidbCmd, 200, payload as any, true);
  const respBytes = await runOidb(bridge, serviceCmd, protobuf_encode<OidbBase<NTV2RichMediaReq>>(env));
  const resp = protobuf_decode<OidbBase<NTV2RichMediaResp>>(respBytes).body;

  ensureRetCodeZero('ntv2 download', resp?.respHead?.retCode, resp?.respHead?.message, undefined);
  const domain = typeof resp?.download?.info?.domain === 'string' ? resp.download.info.domain : '';
  const path = typeof resp?.download?.info?.urlPath === 'string' ? resp.download.info.urlPath : '';
  const rKeyParam = typeof resp?.download?.rKeyParam === 'string' ? resp.download.rKeyParam : '';

  if (!domain || !path) {
    throw new Error('ntv2 download response invalid');
  }
  return `https://${domain}${path}${rKeyParam}`;
}

export class GroupFileApi {
  constructor(private readonly ctx: BridgeContext) {}

  // ─────────────── publish (group file → chat) ───────────────

  /**
   * Publish a previously-uploaded group file as a chat message.
   *
   * Wire is OIDB `OidbSvcTrpcTcp.0x6d9_4` — NOT `MessageSvc.PbSendMsg`.
   * Lagrange.Core V2 splits these two roles: the file UPLOAD path goes
   * via 0x6D6_0 + highway PUT, then a SECOND OIDB hop (this one) tells
   * the QQ server "now publish that staged blob as a chat message" so
   * everyone in the group can see the file bubble.
   *
   * The old approach — wrap the file as `TransElem(elemType=24)` inside
   * `richText.elems[]` and ship it via PbSendMsg — works for INCOMING
   * messages (the receive decoder unpacks transElem(24) into a
   * FileEntity) but the QQ-NT server REJECTS it on outgoing with
   * `result=79` ("invalid element on send-side"). Mirror Lagrange's
   * dedicated GroupSendFileService instead.
   *
   * The unused `field4` slot and the `field3=random` value match
   * Lagrange's send-side defaults (`OidbSvcTrpcTcp0x6D9_4.cs` + the
   * `Random.Shared.Next()` call in `GroupSendFileService.cs`). Field 5
   * is the `Field5=true` flag the receiver's deserializer expects.
   */
  async publish(groupId: number, fileId: string): Promise<void> {
    if (!fileId) throw new Error('publish requires fileId');
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbGroupSendFileReq>(0x6D9, 4, {
      body: {
        groupUin: groupId,
        type: 2,
        info: {
          busiType: 102,
          fileId,
          field3: Math.floor(Math.random() * 0x7fffffff) >>> 0,
          field5: true,
        },
      },
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d9_4', protobuf_encode<OidbBase<OidbGroupSendFileReq>>(env));
  }

  // ─────────────── count ───────────────

  async getCount(groupId: number): Promise<{ fileCount: number; maxCount: number }> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbGroupFileCountViewReq>(
      0x6D8, 3,
      { count: { groupUin: groupId, appId: 7, busId: 0 } },
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d8_3', protobuf_encode<OidbBase<OidbGroupFileCountViewReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbGroupFileCountViewResp>>(respBytes).body;
    return {
      fileCount: toInt(resp?.count?.fileCount ?? 0),
      maxCount: toInt(resp?.count?.maxCount ?? 10000),
    };
  }

  // ─────────────── upload ───────────────

  async upload(
    groupId: number,
    source: string,
    name = '',
    folderId = '/',
    uploadFile = true,
  ): Promise<UploadFileResult> {
    const bridge = asBridge(this.ctx);
    // Group/private files may legitimately be up to 4 GiB on QQ's wire,
    // so override the default 1 GiB cap with the protocol ceiling.
    const loaded = await loadBinarySource(source, 'file', FILE_UPLOAD_MAX_BYTES);
    if (!loaded.bytes.length) throw new Error('group file is empty');

    const fileName = normalizeUploadFileName(name, loaded.fileName);
    const hashes = computeHashes(loaded.bytes);

    const env = makeOidbEnvelope<OidbGroupFileReq>(
      0x6D6, 0,
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
      true,
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d6_0', protobuf_encode<OidbBase<OidbGroupFileReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbGroupFileResp>>(respBytes).body;

    const upload = resp?.upload;
    if (!upload) throw new Error('group file upload response missing');
    ensureRetCodeZero('group file upload', upload.retCode, upload.retMsg, upload.clientWording);

    const fileId = typeof upload.fileId === 'string' && upload.fileId ? upload.fileId : null;
    if (!fileId) throw new Error('group file upload response missing file_id');

    // Remember the upload so a later `send_group_msg` carrying just the
    // file_id can route via `publish` without forcing the OneBot caller
    // to thread fileName/size/md5 separately. For groups the wire
    // publish (OIDB 0x6d9_4) only needs the file_id itself, so this is
    // mainly for log-line correctness; the c2c counterpart in
    // `uploadPrivate` is where the cache is actually load-bearing.
    this.ctx.rememberUploadedFile({
      fileId,
      scope: 'group',
      groupId,
      fileName,
      fileSize: loaded.bytes.length,
      fileMd5: hashes.md5,
      fileSha1: hashes.sha1,
      rememberedAt: Date.now(),
    });

    if (!upload.boolFileExist && uploadFile) {
      const senderUin = toInt(this.ctx.identity.uin);
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

    // Stage 3: file is on the server, now publish it as a chat message.
    //
    // Without this, OIDB 0x6D6_0 + highway PUT only stages the bytes —
    // the chat shows nothing. The publish step goes via a dedicated OIDB
    // call (0x6D9_4), NOT via `MessageSvc.PbSendMsg` with a transElem(24)
    // payload — the QQ-NT server rejects that with `result=79`. Mirrors
    // Lagrange.Core V2's `GroupSendFileService.cs`. Suppressed when the
    // caller opts out via `uploadFile=false` (treat that as "I only
    // wanted the slot allocated, hold the chat post"). Routes through
    // `this.publish` so tests can mock at the same Api boundary.
    if (uploadFile) {
      try {
        await this.publish(groupId, fileId);
      } catch (err) {
        // The bytes are already on the server and the fileId is valid —
        // fail loud but don't lose the upload result the action handler
        // committed to returning. Callers can still resolve the file by
        // id; they'll just have to re-publish it themselves.
        log.warn('group file uploaded (fileId=%s) but chat post failed: %s',
          fileId, err instanceof Error ? err.message : String(err));
      }
    }

    return { fileId };
  }

  async uploadPrivate(
    userId: number,
    source: string,
    name = '',
    uploadFile = true,
  ): Promise<UploadFileResult> {
    const bridge = asBridge(this.ctx);
    // Group/private files may legitimately be up to 4 GiB on QQ's wire,
    // so override the default 1 GiB cap with the protocol ceiling.
    const loaded = await loadBinarySource(source, 'file', FILE_UPLOAD_MAX_BYTES);
    if (!loaded.bytes.length) throw new Error('private file is empty');

    const targetUid = await this.ctx.resolveUserUid(userId);
    let selfUid = this.ctx.identity.selfUid;
    if (!selfUid) {
      const selfUin = toInt(this.ctx.identity.uin);
      if (selfUin > 0) {
        selfUid = await this.ctx.resolveUserUid(selfUin);
      }
    }
    if (!selfUid) throw new Error('self uid is unavailable');

    const senderUin = toInt(this.ctx.identity.uin);
    if (senderUin <= 0) throw new Error('invalid self uin for private file upload');

    const fileName = normalizeUploadFileName(name, loaded.fileName);
    const hashes = computeHashes(loaded.bytes);

    const env = makeOidbEnvelope<OidbPrivateFileUploadReq>(0xE37, 1700, {
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
    });
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xe37_1700', protobuf_encode<OidbBase<OidbPrivateFileUploadReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbPrivateFileUploadResp>>(respBytes).body;

    const upload = resp?.upload;
    if (!upload) throw new Error('private file upload response missing');
    ensureRetCodeZero('private file upload', upload.retCode, upload.retMsg, undefined);

    const fileId = typeof upload.uuid === 'string' && upload.uuid ? upload.uuid : null;
    const fileHash = typeof upload.fileAddon === 'string' && upload.fileAddon ? upload.fileAddon : null;
    if (!fileId) throw new Error('private file upload response missing file_id');

    // Cache the metadata so a later `send_private_msg` carrying just
    // `{type:'file', file_id}` can resurrect the full c2c-file packet
    // (NotOnlineFile { fileSize, fileMd5, fileName, fileHash }). Without
    // this the recipient sees a 0-byte file because the OneBot send path
    // has no way to recover those fields from the file_id alone.
    this.ctx.rememberUploadedFile({
      fileId,
      scope: 'private',
      userId,
      fileName,
      fileSize: loaded.bytes.length,
      fileMd5: hashes.md5,
      fileSha1: hashes.sha1,
      fileHash: fileHash ?? '',
      rememberedAt: Date.now(),
    });

    if (!upload.boolFileExist && uploadFile) {
      // Host selection.
      //
      // Current QQ-NT server rollout has stopped populating the legacy
      // `uploadIp` (field 60) entirely. The host now arrives as the first
      // entry of `rtpMediaPlatformUploadAddress` (field 210, repeated
      // IPv4 message) — same place acidify reads it from since their
      // 2026-04 protobuf refactor. Each IPv4 has paired `inIP`/`inPort`
      // (LAN, same DC as the OIDB endpoint) and `outIP`/`outPort` (WAN);
      // acidify uses `inIP`/`inPort` exclusively and so do we, because
      // that's the address the highway PUT actually needs to reach.
      //
      // The 32-bit IPs are little-endian-packed (byte0 = first octet)
      // per acidify's `Int.toIpString()`. Cross-checked the byte order
      // by inspecting their highway flow — there's no separate htonl
      // step, so the integer is already in network-octet-first order.
      //
      // Older server versions still populate the legacy string fields
      // (uploadIp / uploadDomain / uploadIpList[0] / uploadHttpsDomain /
      // uploadDns), so we fall through to those after rtpMediaPlatform.
      // Pair an HTTPS-flavored host with `uploadHttpsPort` if that's
      // what we picked.
      const rtpFirst = (Array.isArray(upload.rtpMediaPlatformUploadAddress)
        && upload.rtpMediaPlatformUploadAddress[0])
        ? upload.rtpMediaPlatformUploadAddress[0] : null;
      const rtpInIP = rtpFirst && typeof rtpFirst.inIP === 'number' && rtpFirst.inIP !== 0
        ? int32ToIpv4Dotted(rtpFirst.inIP) : '';
      const rtpInPort = rtpFirst && typeof rtpFirst.inPort === 'number'
        ? rtpFirst.inPort : 0;
      const ipListFirst = (Array.isArray(upload.uploadIpList) && upload.uploadIpList[0])
        ? upload.uploadIpList[0] : '';
      const uploadHost = (rtpInIP)
        || (typeof upload.uploadIp === 'string' && upload.uploadIp)
        || (typeof upload.uploadDomain === 'string' && upload.uploadDomain)
        || (ipListFirst)
        || (typeof upload.uploadHttpsDomain === 'string' && upload.uploadHttpsDomain)
        || (typeof upload.uploadDns === 'string' && upload.uploadDns)
        || '';
      const httpsHostUsed = !rtpInIP && !upload.uploadIp && !upload.uploadDomain && !ipListFirst
        && typeof upload.uploadHttpsDomain === 'string' && !!upload.uploadHttpsDomain;
      const uploadPort = rtpInIP && rtpInPort > 0
        ? rtpInPort
        : httpsHostUsed && toInt(upload.uploadHttpsPort) > 0
          ? toInt(upload.uploadHttpsPort)
          : toInt(upload.uploadPort);
      if (!uploadHost || uploadPort <= 0) {
        // Surface every host-bearing field we know about so a user
        // hitting this can show us exactly which slot the server filled
        // (or whether it returned nothing at all — which would point at
        // a request mismatch rather than a missing decoder).
        const rtpDump = Array.isArray(upload.rtpMediaPlatformUploadAddress)
          ? JSON.stringify(upload.rtpMediaPlatformUploadAddress.map((e: any) => ({
            outIP: e.outIP, outPort: e.outPort, inIP: e.inIP, inPort: e.inPort,
            iPType: e.iPType,
          })))
          : '[]';
        log.warn(
          'private file upload host missing — rtp=%s ip=%s domain=%s ipList=%s httpsDomain=%s dns=%s lanip=%s port=%s httpsPort=%s',
          rtpDump,
          upload.uploadIp ?? '', upload.uploadDomain ?? '',
          JSON.stringify(upload.uploadIpList ?? []),
          upload.uploadHttpsDomain ?? '', upload.uploadDns ?? '',
          upload.uploadLanip ?? '', upload.uploadPort ?? 0,
          upload.uploadHttpsPort ?? 0,
        );
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

    // Stage 3: publish the file as a c2c chat message. C2C files use
    // `RichText.notOnlineFile` (parallel to `elems`), so we go through
    // the dedicated `sendC2cFile` on MessageApi instead of `sendPrivate`
    // which only knows about elems[]. NapCat does the same atomic
    // upload+send dance — without it the file sits on the server and
    // the recipient sees nothing.
    if (uploadFile) {
      try {
        await this.ctx.apis.message.sendC2cFile(userId, targetUid, {
          fileId,
          fileName,
          fileSize: loaded.bytes.length,
          fileMd5: hashes.md5,
          fileHash: fileHash ?? '',
        });
      } catch (err) {
        log.warn('private file uploaded (fileId=%s) but chat post failed: %s',
          fileId, err instanceof Error ? err.message : String(err));
      }
    }

    return { fileId, fileHash };
  }

  // ─────────────── list ───────────────

  async list(groupId: number, folderId = '/'): Promise<GroupFilesResult> {
    const bridge = asBridge(this.ctx);
    const targetDirectory = normalizeDirectory(folderId);
    const files: GroupFileInfo[] = [];
    const folders: GroupFolderInfo[] = [];

    const pageSize = 20;
    let startIndex = 0;
    for (let page = 0; page < 200; page++) {
      const env = makeOidbEnvelope<OidbGroupFileViewReq>(
        0x6D8, 1,
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
        true,
      );
      const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d8_1', protobuf_encode<OidbBase<OidbGroupFileViewReq>>(env));
      const resp = protobuf_decode<OidbBase<OidbGroupFileViewResp>>(respBytes).body;

      const list = resp?.list;
      if (!list) break;
      ensureRetCodeZero('group file list', list.retCode, list.retMsg, list.clientWording);

      for (const item of list.items ?? []) {
        const type = toInt(item?.type);
        if (type === 1 && item?.fileInfo) {
          const file = item.fileInfo;
          const uploader = toInt(file.uploaderUin);
          const cached = this.ctx.identity.findGroupMember(groupId, uploader);
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
          const cached = this.ctx.identity.findGroupMember(groupId, creator);
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

  // ─────────────── url fetch (group / private files) ───────────────

  async getUrl(groupId: number, fileId: string, busId = 102): Promise<string> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbGroupFileReq>(
      0x6D6, 2,
      {
        download: {
          groupUin: groupId,
          appId: 7,
          busId,
          fileId,
        },
      },
      true,
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d6_2', protobuf_encode<OidbBase<OidbGroupFileReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbGroupFileResp>>(respBytes).body;

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

  async getPrivateUrl(userId: number, fileId: string, fileHash: string): Promise<string> {
    const bridge = asBridge(this.ctx);
    const selfUid = await resolveSelfUid(bridge);
    void userId;
    const env = makeOidbEnvelope<OidbPrivateFileDownloadReq>(0xE37, 1200, {
      subCommand: 1200,
      field2: 1,
      body: {
        receiverUid: selfUid,
        fileUuid: fileId,
        type: 2,
        fileHash,
        t2: 0,
      },
      field101: 3,
      field102: 103,
      field200: 1,
      field99999: new Uint8Array([0xC0, 0x85, 0x2C, 0x01]),
    });
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xe37_1200', protobuf_encode<OidbBase<OidbPrivateFileDownloadReq>>(env), 5000);
    const resp = protobuf_decode<OidbBase<OidbPrivateFileDownloadResp>>(respBytes).body;

    const result = resp?.body?.result;
    const server = typeof result?.server === 'string' ? result.server : '';
    const port = toInt(result?.port);
    const url = typeof result?.url === 'string' ? result.url : '';
    if (!server || !port || !url) {
      throw new Error('private file url response invalid');
    }
    return `http://${server}:${port}${url}&isthumb=0`;
  }

  // ─────────────── delete / move ───────────────

  async delete(groupId: number, fileId: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbGroupFileReq>(
      0x6D6, 3,
      {
        delete: {
          groupUin: groupId,
          busId: 102,
          fileId,
        },
      },
      true,
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d6_3', protobuf_encode<OidbBase<OidbGroupFileReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbGroupFileResp>>(respBytes).body;

    const result = resp?.delete;
    if (!result) throw new Error('group file delete response missing');
    ensureRetCodeZero('group file delete', result.retCode, result.retMsg, result.clientWording);
  }

  async move(
    groupId: number,
    fileId: string,
    parentDirectory: string,
    targetDirectory: string,
  ): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbGroupFileReq>(
      0x6D6, 5,
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
      true,
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d6_5', protobuf_encode<OidbBase<OidbGroupFileReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbGroupFileResp>>(respBytes).body;

    const result = resp?.move;
    if (!result) throw new Error('group file move response missing');
    ensureRetCodeZero('group file move', result.retCode, result.retMsg, result.clientWording);
  }

  // ─────────────── folders ───────────────

  async createFolder(groupId: number, name: string, parentId = '/'): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbGroupFileFolderReq>(
      0x6D7, 0,
      {
        create: {
          groupUin: groupId,
          rootDirectory: normalizeDirectory(parentId),
          folderName: name,
        },
      },
      true,
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d7_0', protobuf_encode<OidbBase<OidbGroupFileFolderReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbGroupFileFolderResp>>(respBytes).body;

    const result = resp?.create;
    if (!result) throw new Error('group folder create response missing');
    ensureRetCodeZero('group folder create', result.retcode, result.retMsg, result.clientWording);
  }

  async deleteFolder(groupId: number, folderId: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbGroupFileFolderReq>(
      0x6D7, 1,
      {
        delete: {
          groupUin: groupId,
          folderId,
        },
      },
      true,
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d7_1', protobuf_encode<OidbBase<OidbGroupFileFolderReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbGroupFileFolderResp>>(respBytes).body;

    const result = resp?.delete;
    if (!result) throw new Error('group folder delete response missing');
    ensureRetCodeZero('group folder delete', result.retcode, result.retMsg, result.clientWording);
  }

  async renameFolder(groupId: number, folderId: string, newFolderName: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbGroupFileFolderReq>(
      0x6D7, 2,
      {
        rename: {
          groupUin: groupId,
          folderId,
          newFolderName,
        },
      },
      true,
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x6d7_2', protobuf_encode<OidbBase<OidbGroupFileFolderReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbGroupFileFolderResp>>(respBytes).body;

    const result = resp?.rename;
    if (!result) throw new Error('group folder rename response missing');
    ensureRetCodeZero('group folder rename', result.retcode, result.retMsg, result.clientWording);
  }

  // ─────────────── rich-media URL by node ───────────────

  async getPttUrl(groupId: number, node: MediaIndexNode): Promise<string> {
    const bridge = asBridge(this.ctx);
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

  async getPrivatePttUrl(node: MediaIndexNode): Promise<string> {
    const bridge = asBridge(this.ctx);
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

  async getVideoUrl(groupId: number, node: MediaIndexNode): Promise<string> {
    const bridge = asBridge(this.ctx);
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

  async getPrivateVideoUrl(node: MediaIndexNode): Promise<string> {
    const bridge = asBridge(this.ctx);
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
}
