// Group + private file operations: upload (with highway fast-path),
// folder management, file listing, file/media URL fetch. All upload
// paths share the same shape (resolve target → OIDB metadata exchange
// → highway HTTP PUT if the server says we must), but the OIDB schemas
// and field layouts differ enough between group and private that they
// stay as separate functions.

import type { Bridge } from '../bridge';
import { protoEncode } from '../../protobuf/decode';
import { runOidb } from '../bridge-oidb';
import { fetchHighwaySession, uploadHighwayHttp } from '../highway/highway-client';
import { computeHashes, computeMd5, FILE_UPLOAD_MAX_BYTES, loadBinarySource } from '../highway/utils';
import {
  OidbGroupFileCountViewReqSchema,
  OidbGroupFileCountViewRespSchema,
  OidbGroupFileFolderReqSchema,
  OidbGroupFileFolderRespSchema,
  OidbGroupFileReqSchema,
  OidbGroupFileRespSchema,
  OidbGroupFileViewReqSchema,
  OidbGroupFileViewRespSchema,
  OidbPrivateFileDownloadReqSchema,
  OidbPrivateFileDownloadRespSchema,
  OidbPrivateFileUploadReqSchema,
  OidbPrivateFileUploadRespSchema,
  NTV2RichMediaReqSchema,
  NTV2RichMediaRespSchema,
} from '../proto/oidb-action';
import { FileUploadExtSchema } from '../proto/highway';
import { toHexUpper } from '../../utils/hex';
import { ensureRetCodeZero, resolveSelfUid, toInt, type MediaIndexNode } from './shared';

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

// Re-export so this file is a one-stop-shop for the file API surface
// (bridge.ts imports MediaIndexNode through here for type symmetry).
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
  const resp = await runOidb<any>(bridge, {
    cmd: serviceCmd,
    oidbCmd, subCmd: 200,
    request: { schema: NTV2RichMediaReqSchema, value: payload, isUid: true },
    response: { schema: NTV2RichMediaRespSchema },
  });

  ensureRetCodeZero('ntv2 download', resp?.respHead?.retCode, resp?.respHead?.message, undefined);
  const domain = typeof resp?.download?.info?.domain === 'string' ? resp.download.info.domain : '';
  const path = typeof resp?.download?.info?.urlPath === 'string' ? resp.download.info.urlPath : '';
  const rKeyParam = typeof resp?.download?.rKeyParam === 'string' ? resp.download.rKeyParam : '';

  if (!domain || !path) {
    throw new Error('ntv2 download response invalid');
  }
  return `https://${domain}${path}${rKeyParam}`;
}

// ─────────────── file count ───────────────

export async function fetchGroupFileCount(bridge: Bridge, groupId: number): Promise<{ fileCount: number; maxCount: number }> {
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x6d8_3',
    oidbCmd: 0x6D8, subCmd: 3,
    request: {
      schema: OidbGroupFileCountViewReqSchema,
      value: { count: { groupUin: groupId, appId: 7, busId: 0 } },
    },
    response: { schema: OidbGroupFileCountViewRespSchema },
  });
  return {
    fileCount: toInt(resp?.count?.fileCount ?? 0),
    maxCount: toInt(resp?.count?.maxCount ?? 10000),
  };
}

// ─────────────── upload ───────────────

export async function uploadGroupFile(
  bridge: Bridge,
  groupId: number,
  source: string,
  name = '',
  folderId = '/',
  uploadFile = true,
): Promise<UploadFileResult> {
  // Group/private files may legitimately be up to 4 GiB on QQ's wire,
  // so override the default 1 GiB cap with the protocol ceiling.
  const loaded = await loadBinarySource(source, 'file', FILE_UPLOAD_MAX_BYTES);
  if (!loaded.bytes.length) throw new Error('group file is empty');

  const fileName = normalizeUploadFileName(name, loaded.fileName);
  const hashes = computeHashes(loaded.bytes);

  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x6d6_0',
    oidbCmd: 0x6D6, subCmd: 0,
    request: {
      schema: OidbGroupFileReqSchema,
      value: {
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
      isUid: true,
    },
    response: { schema: OidbGroupFileRespSchema },
  });

  const upload = resp?.upload;
  if (!upload) throw new Error('group file upload response missing');
  ensureRetCodeZero('group file upload', upload.retCode, upload.retMsg, upload.clientWording);

  const fileId = typeof upload.fileId === 'string' && upload.fileId ? upload.fileId : null;
  if (!fileId) throw new Error('group file upload response missing file_id');

  if (!upload.boolFileExist && uploadFile) {
    const senderUin = toInt(bridge.identity.uin);
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
  // Group/private files may legitimately be up to 4 GiB on QQ's wire,
  // so override the default 1 GiB cap with the protocol ceiling.
  const loaded = await loadBinarySource(source, 'file', FILE_UPLOAD_MAX_BYTES);
  if (!loaded.bytes.length) throw new Error('private file is empty');

  const targetUid = await bridge.resolveUserUid(userId);
  let selfUid = bridge.identity.selfUid;
  if (!selfUid) {
    const selfUin = toInt(bridge.identity.uin);
    if (selfUin > 0) {
      selfUid = await bridge.resolveUserUid(selfUin);
    }
  }
  if (!selfUid) throw new Error('self uid is unavailable');

  const senderUin = toInt(bridge.identity.uin);
  if (senderUin <= 0) throw new Error('invalid self uin for private file upload');

  const fileName = normalizeUploadFileName(name, loaded.fileName);
  const hashes = computeHashes(loaded.bytes);

  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xe37_1700',
    oidbCmd: 0xE37, subCmd: 1700,
    request: {
      schema: OidbPrivateFileUploadReqSchema,
      value: {
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
    },
    response: { schema: OidbPrivateFileUploadRespSchema },
  });

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

// ─────────────── list ───────────────

export async function fetchGroupFiles(bridge: Bridge, groupId: number, folderId = '/'): Promise<GroupFilesResult> {
  const targetDirectory = normalizeDirectory(folderId);
  const files: GroupFileInfo[] = [];
  const folders: GroupFolderInfo[] = [];

  const pageSize = 20;
  let startIndex = 0;
  for (let page = 0; page < 200; page++) {
    const resp = await runOidb<any>(bridge, {
      cmd: 'OidbSvcTrpcTcp.0x6d8_1',
      oidbCmd: 0x6D8, subCmd: 1,
      request: {
        schema: OidbGroupFileViewReqSchema,
        value: {
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
        isUid: true,
      },
      response: { schema: OidbGroupFileViewRespSchema },
    });

    const list = resp?.list;
    if (!list) break;
    ensureRetCodeZero('group file list', list.retCode, list.retMsg, list.clientWording);

    for (const item of list.items ?? []) {
      const type = toInt(item?.type);
      if (type === 1 && item?.fileInfo) {
        const file = item.fileInfo;
        const uploader = toInt(file.uploaderUin);
        const cached = bridge.identity.findGroupMember(groupId, uploader);
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
        const cached = bridge.identity.findGroupMember(groupId, creator);
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

export async function fetchGroupFileUrl(bridge: Bridge, groupId: number, fileId: string, busId = 102): Promise<string> {
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x6d6_2',
    oidbCmd: 0x6D6, subCmd: 2,
    request: {
      schema: OidbGroupFileReqSchema,
      value: {
        download: {
          groupUin: groupId,
          appId: 7,
          busId,
          fileId,
        },
      },
      isUid: true,
    },
    response: { schema: OidbGroupFileRespSchema },
  });

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

export async function fetchPrivateFileUrl(bridge: Bridge, userId: number, fileId: string, fileHash: string): Promise<string> {
  const uid = await bridge.resolveUserUid(userId);
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xe37_1200',
    oidbCmd: 0xE37, subCmd: 1200,
    request: {
      schema: OidbPrivateFileDownloadReqSchema,
      value: {
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
    },
    response: { schema: OidbPrivateFileDownloadRespSchema },
  });

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

export async function deleteGroupFile(bridge: Bridge, groupId: number, fileId: string): Promise<void> {
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x6d6_3',
    oidbCmd: 0x6D6, subCmd: 3,
    request: {
      schema: OidbGroupFileReqSchema,
      value: {
        delete: {
          groupUin: groupId,
          busId: 102,
          fileId,
        },
      },
      isUid: true,
    },
    response: { schema: OidbGroupFileRespSchema },
  });

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
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x6d6_5',
    oidbCmd: 0x6D6, subCmd: 5,
    request: {
      schema: OidbGroupFileReqSchema,
      value: {
        move: {
          groupUin: groupId,
          appId: 7,
          busId: 102,
          fileId,
          parentDirectory,
          targetDirectory,
        },
      },
      isUid: true,
    },
    response: { schema: OidbGroupFileRespSchema },
  });

  const result = resp?.move;
  if (!result) throw new Error('group file move response missing');
  ensureRetCodeZero('group file move', result.retCode, result.retMsg, result.clientWording);
}

// ─────────────── folders ───────────────

export async function createGroupFileFolder(bridge: Bridge, groupId: number, name: string, parentId = '/'): Promise<void> {
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x6d7_0',
    oidbCmd: 0x6D7, subCmd: 0,
    request: {
      schema: OidbGroupFileFolderReqSchema,
      value: {
        create: {
          groupUin: groupId,
          rootDirectory: normalizeDirectory(parentId),
          folderName: name,
        },
      },
      isUid: true,
    },
    response: { schema: OidbGroupFileFolderRespSchema },
  });

  const result = resp?.create;
  if (!result) throw new Error('group folder create response missing');
  ensureRetCodeZero('group folder create', result.retcode, result.retMsg, result.clientWording);
}

export async function deleteGroupFileFolder(bridge: Bridge, groupId: number, folderId: string): Promise<void> {
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x6d7_1',
    oidbCmd: 0x6D7, subCmd: 1,
    request: {
      schema: OidbGroupFileFolderReqSchema,
      value: {
        delete: {
          groupUin: groupId,
          folderId,
        },
      },
      isUid: true,
    },
    response: { schema: OidbGroupFileFolderRespSchema },
  });

  const result = resp?.delete;
  if (!result) throw new Error('group folder delete response missing');
  ensureRetCodeZero('group folder delete', result.retcode, result.retMsg, result.clientWording);
}

export async function renameGroupFileFolder(bridge: Bridge, groupId: number, folderId: string, newFolderName: string): Promise<void> {
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x6d7_2',
    oidbCmd: 0x6D7, subCmd: 2,
    request: {
      schema: OidbGroupFileFolderReqSchema,
      value: {
        rename: {
          groupUin: groupId,
          folderId,
          newFolderName,
        },
      },
      isUid: true,
    },
    response: { schema: OidbGroupFileFolderRespSchema },
  });

  const result = resp?.rename;
  if (!result) throw new Error('group folder rename response missing');
  ensureRetCodeZero('group folder rename', result.retcode, result.retMsg, result.clientWording);
}

// ─────────────── rich-media URL by node ───────────────

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
