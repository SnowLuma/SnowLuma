import { createLogger } from '@snowluma/common/logger';
import type { BridgeContext } from '../bridge-context';
import type { MessageElement } from '../events';
import { GROUP_IMAGE_CMD_ID, PRIVATE_IMAGE_CMD_ID } from './highway-client';
import {
  finalizeMediaMsgInfo,
  hexToBytes,
  runNtv2Upload,
  type MediaSubFileUpload,
} from './pipeline';
import { computeHashes, detectImageFormat, loadBinarySource } from './utils';

const moduleLog = createLogger('Highway.Image');

function loggerFor(bridge: BridgeContext) {
  const raw = bridge.identity?.uin;
  const uin = typeof raw === 'string' ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(uin) && uin > 0 ? moduleLog.child({ uin }) : moduleLog;
}

interface ImageData {
  /** Empty when the caller is forwarding from cached fingerprints. */
  bytes: Uint8Array;
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  fileName: string;
  fileSize: number;
  summary: string;
  subType: number;
  width: number;
  height: number;
  picFormat: number;
  /** True when `bytes` is empty; runNtv2Upload throws fastOnlyError if
   *  the server demands the bytes anyway. */
  fastOnly: boolean;
}

function imageDataFromFingerprint(element: MessageElement): ImageData {
  return {
    bytes: new Uint8Array(0),
    md5: hexToBytes(element.md5Hex ?? ''),
    sha1: hexToBytes(element.sha1Hex ?? ''),
    md5Hex: element.md5Hex ?? '',
    sha1Hex: element.sha1Hex ?? '',
    fileName: element.fileName || `${element.md5Hex ?? 'image'}.jpg`,
    fileSize: element.fileSize ?? 0,
    // QQ ecosystem convention — mobile QQ + Lagrange.Core + NapCat all
    // surface these exact Chinese strings as the chat-list bubble
    // preview text. English fallbacks would render `[image]` /
    // `[sticker]` in QQ users' chat lists instead of the expected
    // `[图片]` / `[动画表情]`. Cross-checked against:
    //   dev/NapCatQQ/.../packet/message/element.ts:367-371
    //   dev/Lagrange.Core/.../Message/Entity/ImageEntity.cs:186-192
    summary: element.summary || (element.subType === 1 ? '[动画表情]' : '[图片]'),
    subType: element.subType ?? 0,
    width: element.width ?? 0,
    height: element.height ?? 0,
    picFormat: element.picFormat ?? 1000,
    fastOnly: true,
  };
}

function loadImage(element: MessageElement): Promise<ImageData> {
  if (element.noByteFallback) {
    if (!element.md5Hex || !element.sha1Hex) {
      return Promise.reject(new Error('image fast-upload requires md5Hex + sha1Hex'));
    }
    return Promise.resolve(imageDataFromFingerprint(element));
  }
  return loadImageFromSource(
    element.url || element.imageUrl || element.fileId || '',
    element.fileName ?? '',
    element.subType ?? 0,
    element.summary ?? '',
  );
}

async function loadImageFromSource(source: string, fileName: string, subType: number, summary: string): Promise<ImageData> {
  const loaded = await loadBinarySource(source, 'image');
  const hashes = computeHashes(loaded.bytes);
  const fmt = detectImageFormat(loaded.bytes);

  const extMap: Record<number, string> = { 1000: '.jpg', 1001: '.png', 1002: '.webp', 1005: '.bmp', 2000: '.gif' };
  const ext = extMap[fmt.format] ?? '.jpg';

  let finalName = fileName || loaded.fileName;
  if (!finalName) finalName = hashes.md5Hex + ext;

  return {
    bytes: loaded.bytes,
    md5: hashes.md5,
    sha1: hashes.sha1,
    md5Hex: hashes.md5Hex,
    sha1Hex: hashes.sha1Hex,
    fileName: finalName,
    fileSize: loaded.bytes.length,
    summary: summary || (subType === 1 ? '[动画表情]' : '[图片]'),
    subType,
    width: fmt.width,
    height: fmt.height,
    picFormat: fmt.format,
    fastOnly: false,
  };
}

/**
 * Upload an image and return the encoded MsgInfo bytes for the outgoing
 * commonElem.
 */
export async function uploadImageMsgInfo(
  bridge: BridgeContext,
  isGroup: boolean,
  targetIdOrUid: string | number,
  element: MessageElement,
): Promise<Uint8Array> {
  const log = loggerFor(bridge);
  const image = await loadImage(element);
  log.debug('uploading %d bytes md5=%s... → %s %s',
    image.fileSize,
    image.md5Hex.slice(0, 8),
    isGroup ? 'group' : 'c2c',
    String(targetIdOrUid));

  const uploads: MediaSubFileUpload[] = [{
    source: 'top',
    cmdId: isGroup ? GROUP_IMAGE_CMD_ID : PRIVATE_IMAGE_CMD_ID,
    bytes: image.bytes,
    md5: image.md5,
    sha1: image.sha1,
    fastOnlyError: 'image fast-upload not available (server requires bytes)',
  }];

  const upload = await runNtv2Upload({
    bridge,
    isGroup,
    targetIdOrUid,
    oidbCmd: isGroup ? 0x11C4 : 0x11C5,
    serviceCmd: isGroup ? 'OidbSvcTrpcTcp.0x11c4_100' : 'OidbSvcTrpcTcp.0x11c5_100',
    requestId: 1,
    businessType: 1,
    uploadInfo: [{
      fileInfo: {
        fileSize: image.fileSize,
        fileHash: image.md5Hex,
        fileSha1: image.sha1Hex,
        fileName: image.fileName,
        type: { type: 1, picFormat: image.picFormat, videoFormat: 0, voiceFormat: 0 },
        width: image.width,
        height: image.height,
        time: 0,
        original: 1,
      },
      subFileType: 0,
    }],
    compatQmsgSceneType: isGroup ? 2 : 1,
    extBizInfo: {
      pic: {
        bizType: image.subType,
        textSummary: image.summary,
        ...(isGroup
          ? { reserveTroop: { subType: image.subType } }
          : { reserveC2c: { subType: image.subType } }),
      },
      video: { bytesPbReserve: new Uint8Array(0) },
      ptt: {
        bytesReserve: new Uint8Array(0),
        bytesPbReserve: new Uint8Array(0),
        bytesGeneralFlags: new Uint8Array(0),
      },
    },
    uploads,
    label: 'image',
  });

  return finalizeMediaMsgInfo(upload, { bizType: image.subType, textSummary: image.summary });
}
