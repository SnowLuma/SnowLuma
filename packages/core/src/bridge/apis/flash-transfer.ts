// FlashTransferApi — 闪传（fileset）业务编排。
// 复用 OIDB 基础设施（invokeOidb），协议层在 @snowluma/protocol/oidb-services/flash-transfer/。

import type { BridgeContext } from '../bridge-context';
import type { FlashFileEntry } from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { GetFilesetDetail } from '@snowluma/protocol/oidb-services/flash-transfer/get-fileset-detail';
import { ListFilesets } from '@snowluma/protocol/oidb-services/flash-transfer/list-filesets';
import { GetDownloadUrl } from '@snowluma/protocol/oidb-services/flash-transfer/get-download-url';
import { GetFlashDownload } from '@snowluma/protocol/oidb-services/flash-transfer/get-flash-download';
import { DeleteFlashFile } from '@snowluma/protocol/oidb-services/flash-transfer/delete-file';
import { RenameFlashFile } from '@snowluma/protocol/oidb-services/flash-transfer/rename-file';
import { ApplyFileset } from '@snowluma/protocol/oidb-services/flash-transfer/apply-fileset';
import { CommitFile } from '@snowluma/protocol/oidb-services/flash-transfer/commit-file';
import { CompleteFileset } from '@snowluma/protocol/oidb-services/flash-transfer/complete-fileset';
import { SetFilesetStatus } from '@snowluma/protocol/oidb-services/flash-transfer/set-status';
import { ApplyUpload } from '@snowluma/protocol/oidb-services/flash-transfer/apply-upload';
import { PrepareUpload } from '@snowluma/protocol/oidb-services/flash-transfer/prepare-upload';
import { SendFlashMsg } from '@snowluma/protocol/oidb-services/flash-transfer/send-flash';
import { loadBinarySource, computeHashes } from '@snowluma/protocol/highway/utils';
import { computeSha1StateV } from '@snowluma/protocol/highway/sha1-stream';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import type { FlashSliceUploadBody, FlashSliceUploadResp, FlashFileId } from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** 闪传文件信息（业务层，从 FlashFileEntry 转换）。 */
export interface FlashFileInfo {
  filesetUuid: string;
  fileName: string;
  origName: string;
  fileSize: number;
  /** 上传/分享链接 qfile.qq.com/q/<code>。 */
  shareUrl: string;
  fileId: string;
  /** 下载链接 multimedia.qfile.qq.com/download?...&rkey=... */
  downloadUrl: string;
}

function entryToInfo(e: FlashFileEntry): FlashFileInfo {
  return {
    filesetUuid: e.filesetUuid ?? '',
    fileName: e.fileName ?? '',
    origName: e.origName ?? '',
    fileSize: Number(e.fileSize ?? 0),
    shareUrl: e.uploadUrlWrap?.uploadUrl ?? '',
    fileId: e.fileIdWrap?.fileId ?? '',
    downloadUrl: e.fileIdWrap?.download?.downloadUrl ?? '',
  };
}

// 手写 PNG 编码（zlib 压缩，避免引入图像库）。缩略图用随机纯色，每次 SHA1 不同，
// 避免命中服务端秒传缓存。
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 生成 width×height 随机纯色 PNG（8-bit RGB）。每次随机颜色，SHA1 不同以避免秒传。 */
function generatePng(width: number, height: number): Buffer {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const off = y * rowLen;
    raw[off] = 0;  // filter none
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = r;
      raw[off + 1 + x * 3 + 1] = g;
      raw[off + 1 + x * 3 + 2] = b;
    }
  }
  const compressed = deflateSync(raw);
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

export class FlashTransferApi {
  constructor(private readonly ctx: BridgeContext) { }

  /** 获取文件集信息（get_fileset_info）。 */
  async getFilesetInfo(filesetUuid: string): Promise<FlashFileInfo[]> {
    const entries = await GetFilesetDetail.invoke(this.ctx, { filesetUuid });
    return entries.map(entryToInfo);
  }

  /** 获取闪传文件列表（get_flash_file_list）。同 getFilesetInfo，返回文件数组。 */
  async getFlashFileList(filesetUuid: string): Promise<FlashFileInfo[]> {
    return this.getFilesetInfo(filesetUuid);
  }

  /**
   * 拿指定文件的下载直链 + 元信息。0x93d4 返回 fileset 内所有文件（f3 repeated，
   * 多文件时每条 f6=序号、f14=主文件 fileId），按 fileIndex 选中后走 0x12a9 sub=200
   * 拿主文件直链。0x93d3/0x93d4 的 downloadUrl 字段是缩略图（appid=14903/14902），
   * 主文件必须走 0x12a9 sub=200。
   */
  private async getFileDownload(
    filesetUuid: string, fileIndex: number = 1,
  ): Promise<{ url: string; fileName: string; fileSize: number } | null> {
    const metas = await GetDownloadUrl.invoke(this.ctx, { filesetUuid });
    const meta = metas.find((m) => m.fileIndex === fileIndex);
    if (!meta || !meta.fileId) return null;
    const url = await GetFlashDownload.invoke(this.ctx, {
      filesetUuid: meta.filesetUuid,
      fileUuid: meta.fileUuid,
      fileId: meta.fileId,
      fileName: meta.fileName,
    });
    if (!url) return null;
    return { url, fileName: meta.fileName, fileSize: meta.fileSize };
  }

  /**
   * 获取闪传文件下载链接（get_flash_file_url）。主文件直链走 0x12a9 sub=200
   * （0x93d3 的 downloadUrl 是缩略图 appid=14903，非主文件）。多文件 fileset 用
   * fileIndex 指定第几个文件（默认 1）。找不到文件或拿不到直链时抛错。
   */
  async getFlashFileUrl(filesetUuid: string, fileIndex: number = 1): Promise<string> {
    const dl = await this.getFileDownload(filesetUuid, fileIndex);
    if (!dl || !dl.url) throw new Error('get_flash_file_url: no download url available');
    return dl.url;
  }

  /**
   * 解析闪传文件下载直链（download_fileset）。返回指定文件的下载 URL + 文件名/大小，
   * 不下载文件内容（由调用方拉）。多文件 fileset 用 fileIndex 指定第几个文件（默认 1）。
   */
  async downloadFileset(
    filesetUuid: string,
    opts?: { fileName?: string; fileIndex?: number },
  ): Promise<{ url: string; fileName: string; fileSize: number }> {
    const dl = await this.getFileDownload(filesetUuid, opts?.fileIndex ?? 1);
    if (!dl || !dl.url) throw new Error('download_fileset: no download url available');
    return dl;
  }

  /** 获取分享链接（get_share_link）= qfile.qq.com/q/<code>。 */
  async getShareLink(filesetUuid: string): Promise<string> {
    const entries = await GetFilesetDetail.invoke(this.ctx, { filesetUuid });
    return entries.find((e) => e.uploadUrlWrap?.uploadUrl)?.uploadUrlWrap?.uploadUrl ?? '';
  }

  /** 列出当前账号的所有 fileset（OneBot 标准未定义，QQ 面板有此入口）。 */
  async listFilesets(): Promise<FlashFileInfo[]> {
    const entries = await ListFilesets.invoke(this.ctx, {});
    return entries.map(entryToInfo);
  }

  /** 删除闪传文件（delete_flash_file）。 */
  async deleteFlashFile(filesetUuid: string): Promise<void> {
    await DeleteFlashFile.invoke(this.ctx, { filesetUuid });
  }

  /** 重命名闪传文件（rename_flash_file）。 */
  async renameFlashFile(filesetUuid: string, newName: string): Promise<void> {
    await RenameFlashFile.invoke(this.ctx, { filesetUuid, newName });
  }

  /**
   * 发送闪传文件（send_flash_msg，0x93d7）。私聊：user_id→uid；群聊：group_id 直接用。
   * 0x93d7 响应无 message_id（分享 fileset，非传统消息），OneBot 层 message_id 由 action 返回 0。
   */
  async sendFlashMsg(filesetUuid: string, target: { userId?: number; groupId?: number }): Promise<void> {
    if (target.groupId) {
      await SendFlashMsg.invoke(this.ctx, { groupId: target.groupId, filesetUuid });
      return;
    }
    const userId = target.userId;
    if (!userId) throw new Error('send_flash_msg: user_id or group_id is required');
    const targetUid = await this.ctx.identity.resolveUid(userId);
    await SendFlashMsg.invoke(this.ctx, { targetUid, filesetUuid });
  }

  /**
   * 从分享码/链接获取 fileset_id（get_fileset_id）。code→UUID 不走 OIDB，QQ 客户端
   * 走 trpc HTTP API；分享页 qfile.qq.com/q/<code> 的 HTML 内嵌了 fileset_id（trpc
   * 接口数据），直接 GET + 正则提取即可，无需复刻带签名的 trpc 调用。
   */
  async getFilesetIdByCode(shareCode: string): Promise<string> {
    const url = /^https?:\/\//i.test(shareCode) ? shareCode : `https://qfile.qq.com/q/${shareCode}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`get_fileset_id: HTTP ${resp.status}`);
    const html = await resp.text();
    // 网页里 fileset_id 以 JSON 嵌入（引号可能被转义为 \"），正则兼容两种形态。
    const m = /fileset_id\\?"\s*:\s*\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(html);
    if (!m) throw new Error('get_fileset_id: fileset_id not found in share page');
    return m[1];
  }

  // ─────────────── 文件上传 ───────────────

  /**
   * 文件扩展名 → 闪传类型码映射。typeCode 用于 0x93cf f3，formatCode 用于
   * 0x93d0 commit f7 与 0x12a9 filesetWrap.f7（两者同值）。mp4 → 2，rar/zip → 4。
   * 未知扩展名按媒体类处理（formatCode=2），服务端按文件名扩展名判定。
   */
  private static fileTypeCode(fileName: string): { typeCode: number; formatCode: number } {
    const ext = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1] ?? '';
    switch (ext) {
      case 'rar': return { typeCode: 2, formatCode: 4 };
      case 'zip': return { typeCode: 6, formatCode: 4 };
      case '7z': case 'gz': case 'tar': case 'bz2': return { typeCode: 2, formatCode: 4 };
      case 'png': case 'jpg': case 'jpeg': case 'bmp': case 'gif': case 'webp':
      case 'mp4': case 'mov': case 'avi': case 'mkv':
        return { typeCode: 7, formatCode: 2 };
      default: return { typeCode: 7, formatCode: 2 };
    }
  }

  /** 构造 sub=103 的 fileId（客户端生成的 protobuf，base64url 编码）。
   *  f2=SHA1, f3=filesize, f4=appid, f5=微秒时间戳, f6="prod",
   *  f10=TTL(1209600), f11=16B 会话ID, f15=3B, f16="gz"。
   *  f11/f15 随机生成，服务端不校验。
   *  appid 决定 fileId 落在哪个槽位：主文件用 14901（0x93d4 f14.f1），
   *  png 缩略图用 14903、jpg 缩略图用 14902（f13.f1）。主文件必须用 14901，
   *  否则 fileId 不会被服务端采纳进 f14，对端无法拿到主文件下载入口。 */
  private static buildFileId(sha1: Uint8Array, fileSize: number, appid: number = 14901): string {
    const fileId: FlashFileId = {
      sha1: new Uint8Array(sha1),
      fileSize,
      appid,
      timestamp: BigInt(Date.now()) * 1000n,   // 微秒时间戳
      env: 'prod',
      ttl: 1209600,
      sessionId: randomBytes(16),
      field15: randomBytes(3),
      region: 'gz',
    };
    return Buffer.from(protobuf_encode<FlashFileId>(fileId)).toString('base64url');
  }

  /**
   * 创建闪传任务（create_flash_task）。所有文件统一走 sub=100/103+sliceupload，
   * 不走小文件 PUT——QQ 客户端即使几百 KB 的文件也走 sliceupload。只有 sliceupload
   * 路径会上报主文件 sha1/size，服务端据此把 fileset 标记为完成（对端可下载）；
   * PUT 路径不上报 sha1，fileset 会卡在"上传中"无法被下载。
   *
   * 多文件：0x93d0 的 f4 是 repeated，一个 commit 请求同时携带 fileset 内所有文件
   * 条目，每条 f6=文件序号（1,2,3...）。commit 在上传前只发一次，之后 complete →
   * 逐个 prepare/apply/sliceupload。prepare/apply 的 filesetWrap.f4 必须与 commit
   * 的 f6 一致，否则文件不计入 fileset。多文件时 ApplyFileset 的 fileName 用
   * 「<首文件名>等N个文件」、fileSize 用总和——服务端据此判定 fileset 为多文件。
   */
  async createFlashTask(files: string | string[], _name?: string, _thumbPath?: string): Promise<{ filesetId: string }> {
    const fileList = Array.isArray(files) ? files : [files];
    if (fileList.length === 0) throw new Error('create_flash_task: files is empty');
    const uploader = {
      uin: this.ctx.identity.uin,
      nickname: this.ctx.identity.nickname,
      uid: this.ctx.identity.selfUid ?? '',
    };
    // 读取所有文件，每个分配 fileUuid + 序号 + formatCode
    const items: { bytes: Uint8Array; fileName: string; fileUuid: string; fileIndex: number; formatCode: number }[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const { bytes, fileName } = await loadBinarySource(fileList[i], 'flash-transfer');
      const { formatCode } = FlashTransferApi.fileTypeCode(fileName);
      items.push({ bytes: new Uint8Array(bytes), fileName, fileUuid: randomUUID(), fileIndex: i + 1, formatCode });
    }
    // 申请 fileset。多文件时 fileName 用「<首文件名>等N个文件」、fileSize 用总和，
    // 服务端据此判定 fileset 为多文件，commit 的后续 entry 才会被计入。
    const first = items[0];
    const { typeCode } = FlashTransferApi.fileTypeCode(first.fileName);
    const isMulti = items.length > 1;
    const filesetName = isMulti ? `${first.fileName}等${items.length}个文件` : first.fileName;
    const totalSize = items.reduce((s, it) => s + it.bytes.length, 0);
    const apply = await ApplyFileset.invoke(this.ctx, {
      fileName: filesetName, origName: filesetName,
      fileSize: totalSize, typeCode, uploader,
    });
    const filesetUuid = apply.filesetUuid;
    if (!filesetUuid) throw new Error('apply fileset failed: missing uuid');
    // 一次性 commit 所有文件元数据（f4 repeated，每条 f6=序号）
    const commitEntries = items.map((it) => ({
      fileUuid: it.fileUuid, fileName: it.fileName, origName: it.fileName,
      fileSize: it.bytes.length, formatCode: it.formatCode, fileIndex: it.fileIndex,
    }));
    await CommitFile.invoke(this.ctx, { filesetUuid, entries: commitEntries });
    await CompleteFileset.invoke(this.ctx, { filesetUuid });
    // 两阶段上传：先全部 prepare+apply 注册 fileId，再全部 sliceupload 落盘。
    const prepared: { it: typeof items[0]; rkey: string; sha1StateV: Uint8Array[]; sliceCount: number }[] = [];
    for (const it of items) {
      const p = await this.prepareAndApply(filesetUuid, it.bytes, it.fileName, it.fileUuid, it.fileIndex, it.formatCode);
      if (p) prepared.push({ it, ...p });
    }
    for (const p of prepared) {
      await this.sliceuploadFile(p.it.bytes, p.rkey, p.sha1StateV, p.sliceCount, p.it.fileName);
    }
    // fileset 级缩略图（序号在主文件之后递增），主文件下载入口需要缩略图关联
    await this.uploadThumbnail(filesetUuid, items[0].fileUuid, 'png', items.length + 1);
    await this.uploadThumbnail(filesetUuid, items[0].fileUuid, 'jpg', items.length + 2);
    await SetFilesetStatus.invoke(this.ctx, { filesetUuid });
    return { filesetId: filesetUuid };
  }

  /**
   * 阶段1：prepare（拿 rkey）+ apply（注册 fileId）。返回 sliceupload 所需的 rkey/sha1state。
   * 秒传（rkey=null）返回 null，调用方跳过 sliceupload。
   */
  private async prepareAndApply(
    filesetUuid: string, bytes: Uint8Array, fileName: string, fileUuid: string, fileIndex: number, formatCode: number,
  ): Promise<{ rkey: string; sha1StateV: Uint8Array[]; sliceCount: number } | null> {
    const fileSize = bytes.length;
    const hashes = computeHashes(bytes);
    const SLICE_SIZE = 1024 * 1024;
    const sliceCount = Math.ceil(fileSize / SLICE_SIZE);
    const sha1StateV = computeSha1StateV(bytes, sliceCount, SLICE_SIZE);

    const rkey = await PrepareUpload.invoke(this.ctx, {
      filesetUuid, fileUuid, fileName, fileSize, sha1: hashes.sha1Hex, fileIndex, formatCode,
    });
    if (rkey === null) return null;  // 秒传

    const fileId = FlashTransferApi.buildFileId(hashes.sha1, fileSize);
    await ApplyUpload.invoke(this.ctx, {
      filesetUuid, fileUuid, fileId, fileName, fileSize,
      md5: hashes.md5Hex, sha1: hashes.sha1Hex, fileIndex, formatCode,
    });
    return { rkey, sha1StateV, sliceCount };
  }

  /**
   * 阶段2：sliceupload 分片上传（所有文件 prepare+apply 完成后调用）。
   */
  private async sliceuploadFile(
    bytes: Uint8Array, rkey: string, sha1StateV: Uint8Array[], sliceCount: number, fileName: string,
  ): Promise<void> {
    const fileSize = bytes.length;
    const SLICE_SIZE = 1024 * 1024;
    for (let i = 0; i < sliceCount; i++) {
      const start = i * SLICE_SIZE;
      const chunk = bytes.subarray(start, Math.min(start + SLICE_SIZE, fileSize));
      const chunkLen = chunk.length;
      const chunkSha1 = new Uint8Array(createHash('sha1').update(Buffer.from(chunk)).digest());
      const body: FlashSliceUploadBody = {
        field1: 0,
        appid: 14901,
        field3: 2,
        payload: {
          field1: {},
          rkey,
          start,
          end: start + chunkLen - 1,
          sha1: chunkSha1,
          sha1StateV: { state: sha1StateV.map((s) => new Uint8Array(s)) },
          chunk: new Uint8Array(chunk),
        },
      };
      const bodyBytes = protobuf_encode<FlashSliceUploadBody>(body);
      await this.postSliceupload(bodyBytes, `${fileName} slice ${i}`);
    }
  }

  /**
   * POST sliceupload 并校验响应。服务端即使 HTTP 200 也可能在业务体里返回错误，
   * 所以必须解析 f5(status)，非 "success" 视为失败。label 用于错误信息定位切片来源。
   */
  private async postSliceupload(bodyBytes: Uint8Array, label: string): Promise<void> {
    const resp = await fetch('https://multimedia.qfile.qq.com/sliceupload', {
      method: 'POST', body: bodyBytes,
      headers: {
        Accept: '*/*', Connection: 'Keep-Alive',
        'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)',
        Pragma: 'no-cache', 'Cache-Control': 'no-cache',
        'Content-Length': String(bodyBytes.length),
        'X-Retried-Times': '1',
      },
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`${label} failed: HTTP ${resp.status} ${errBody.slice(0, 300)}`);
    }
    const respBuf = new Uint8Array(await resp.arrayBuffer());
    const sliceResp = protobuf_decode<FlashSliceUploadResp>(respBuf);
    if (sliceResp.status !== 'success') {
      throw new Error(`${label} failed: ${sliceResp.status || 'no status in response'}`);
    }
  }

  /**
   * 上传占位缩略图（png+jpg）。主文件上传后调用——主文件下载入口（0x93d3 的下载
   * fileId）需要缩略图关联才会被服务端填充，不传缩略图时 bot 自身上传的 fileset
   * 无法被 download_fileset 解析。缩略图用随机纯色 PNG，无需 ffmpeg/sharp。
   * fileIndex 为缩略图在 fileset 内的序号（主文件之后递增），与 commit f6 对齐。
   */
  private async uploadThumbnail(
    filesetUuid: string, mainFileUuid: string, thumbType: 'png' | 'jpg', fileIndex: number,
  ): Promise<void> {
    // 526x360 是 QQ 客户端缩略图尺寸；1x1 会被服务端拒（HTTP 400，宽高太小）。
    const width = 526, height = 360;
    const thumbBytes = generatePng(width, height);  // 随机纯色，SHA1 不同避免秒传
    const appid = thumbType === 'png' ? 14903 : 14902;  // png=14903, jpg=14902
    const fileUuid = thumbType === 'png' ? randomUUID() : mainFileUuid;  // png 独立，jpg 挂主文件
    const fileName = thumbType === 'png'
      ? `${randomUUID().slice(0, 8)}_one.png`
      : `${createHash('md5').update(thumbBytes).digest('hex').slice(0, 32)}.jpg`;
    const hashes = computeHashes(new Uint8Array(thumbBytes));
    const fileSize = thumbBytes.length;
    const thumbFormatCode = thumbType === 'png' ? 26 : 2;  // png缩略图=26, jpg缩略图=2
    const rkey = await PrepareUpload.invoke(this.ctx, {
      filesetUuid, fileUuid, fileName, fileSize, sha1: hashes.sha1Hex,
      fileIndex, formatCode: thumbFormatCode, thumbType, width, height,
    });
    if (rkey === null) return;  // 秒传
    const fileId = FlashTransferApi.buildFileId(hashes.sha1, fileSize, appid);
    await ApplyUpload.invoke(this.ctx, {
      filesetUuid, fileUuid, fileId, fileName, fileSize,
      md5: hashes.md5Hex, sha1: hashes.sha1Hex, fileIndex, formatCode: thumbFormatCode, thumbType, width, height,
    });
    // sliceupload（缩略图小，1 片，Sha1StateV=[标准 SHA1]）
    const sha1StateV = computeSha1StateV(new Uint8Array(thumbBytes), 1, fileSize);
    const body: FlashSliceUploadBody = {
      field1: 0, appid, field3: 2,
      payload: {
        field1: {}, rkey,
        start: 0, end: fileSize - 1,
        sha1: new Uint8Array(hashes.sha1),
        sha1StateV: { state: sha1StateV.map((s) => new Uint8Array(s)) },
        chunk: new Uint8Array(thumbBytes),
      },
    };
    const bodyBytes = protobuf_encode<FlashSliceUploadBody>(body);
    await this.postSliceupload(bodyBytes, 'thumbnail sliceupload');
  }
}
