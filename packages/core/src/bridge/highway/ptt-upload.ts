import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { createLogger } from '../../utils/logger';
import type { Bridge } from '../bridge';
import type { MessageElement } from '../events';
import { defaultPttTempDir, encodeSilk } from './ffmpeg-addon';
import {
  finalizeMediaMsgInfo,
  hexToBytes,
  runNtv2Upload,
  type MediaSubFileUpload,
} from './pipeline';
import { computeHashes, loadBinarySource, resolveLocalFilePath } from './utils';

const moduleLog = createLogger('Highway.Ptt');

function loggerFor(bridge: Bridge) {
  const raw = bridge.identity?.uin;
  const uin = typeof raw === 'string' ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(uin) && uin > 0 ? moduleLog.child({ uin }) : moduleLog;
}

export const PRIVATE_PTT_CMD_ID = 1007;
export const GROUP_PTT_CMD_ID = 1008;

interface PttPayload {
  /** Silk bytes uploaded to Highway. Empty when forwarding from cached fingerprints. */
  bytes: Uint8Array;
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  fileName: string;
  fileSize: number;
  /** Whole seconds, >= 1. */
  duration: number;
  voiceFormat: number;
  /** True when bytes is empty; pipeline throws fastOnlyError if the
   *  server demands the bytes anyway. */
  fastOnly: boolean;
  /** Cleanup hooks for any temp silk files staged during loadPtt. */
  cleanups: Array<() => void>;
}

function pttPayloadFromFingerprint(element: MessageElement): PttPayload {
  return {
    bytes: new Uint8Array(0),
    md5: hexToBytes(element.md5Hex ?? ''),
    sha1: hexToBytes(element.sha1Hex ?? ''),
    md5Hex: element.md5Hex ?? '',
    sha1Hex: element.sha1Hex ?? '',
    fileName: element.fileName || `${element.md5Hex ?? 'record'}.amr`,
    fileSize: element.fileSize ?? 0,
    duration: element.duration ?? 1,
    // Voice format: 1 = silk (NTV2 standard). Honour any fingerprint that
    // declares a different format; legacy NTQQ paths all use 1.
    voiceFormat: element.voiceFormat || 1,
    fastOnly: true,
    cleanups: [],
  };
}

async function loadPtt(element: MessageElement, tempDir: string): Promise<PttPayload> {
  if (element.noByteFallback) {
    if (!element.md5Hex || !element.sha1Hex) {
      throw new Error('record fast-upload requires md5Hex + sha1Hex');
    }
    return pttPayloadFromFingerprint(element);
  }

  const source = element.url || element.fileId || '';
  if (!source) throw new Error('record source is empty');

  const cleanups: Array<() => void> = [];
  // Run all queued cleanups; called both on the success path (via the
  // returned `cleanups` array) and on the failure path (try/catch below).
  const runCleanups = () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (!fn) continue;
      try { fn(); } catch { /* best-effort */ }
    }
  };

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Resolve the on-disk path the addon should read. Anything that isn't
    // already a local file (base64, HTTP) gets staged into the temp dir.
    let inputPath: string;
    const local = resolveLocalFilePath(source);
    if (local && fs.existsSync(local)) {
      inputPath = local;
    } else {
      const loaded = await loadBinarySource(source, 'record');
      inputPath = path.join(tempDir, `snowluma-ptt-in-${crypto.randomUUID()}`);
      fs.writeFileSync(inputPath, Buffer.from(loaded.bytes));
      cleanups.push(() => { try { fs.unlinkSync(inputPath); } catch { /* ignore */ } });
    }

    const silk = await encodeSilk(inputPath, tempDir);
    if (silk.converted) {
      cleanups.push(() => { try { fs.unlinkSync(silk.path); } catch { /* ignore */ } });
      moduleLog.debug('converted record to silk: %s -> %s (duration=%ds)', inputPath, silk.path, silk.duration);
    }

    const silkBytes = new Uint8Array(fs.readFileSync(silk.path));
    if (silkBytes.length === 0) throw new Error('silk file is empty after conversion');

    const hashes = computeHashes(silkBytes);
    return {
      bytes: silkBytes,
      md5: hashes.md5,
      sha1: hashes.sha1,
      md5Hex: hashes.md5Hex,
      sha1Hex: hashes.sha1Hex,
      fileName: `${hashes.md5Hex}.amr`,
      fileSize: silkBytes.length,
      duration: silk.duration,
      voiceFormat: 1,
      fastOnly: false,
      cleanups: [...cleanups],
    };
  } catch (err) {
    runCleanups();
    throw err;
  }
}

/**
 * Upload a voice clip and return the encoded MsgInfo bytes that go inside
 * a `commonElem { serviceType: 48, businessType: 22 }`.
 */
export async function uploadPttMsgInfo(
  bridge: Bridge,
  isGroup: boolean,
  targetIdOrUid: string | number,
  element: MessageElement,
): Promise<Uint8Array> {
  const log = loggerFor(bridge);
  const tempDir = defaultPttTempDir();
  const ptt = await loadPtt(element, tempDir);
  log.debug('uploading %d bytes md5=%s... → %s %s duration=%ds',
    ptt.fileSize,
    ptt.md5Hex.slice(0, 8),
    isGroup ? 'group' : 'c2c',
    String(targetIdOrUid),
    ptt.duration);
  try {
    const uploads: MediaSubFileUpload[] = [{
      source: 'top',
      cmdId: isGroup ? GROUP_PTT_CMD_ID : PRIVATE_PTT_CMD_ID,
      bytes: ptt.bytes,
      md5: ptt.md5,
      sha1: ptt.sha1,
      fastOnlyError: 'record fast-upload not available (server requires bytes)',
    }];

    const upload = await runNtv2Upload({
      bridge,
      isGroup,
      targetIdOrUid,
      oidbCmd: isGroup ? 0x126E : 0x126D,
      serviceCmd: isGroup ? 'OidbSvcTrpcTcp.0x126e_100' : 'OidbSvcTrpcTcp.0x126d_100',
      // NapCat uses requestId=1 for group / 4 for c2c. Mirror it.
      requestId: isGroup ? 1 : 4,
      businessType: 3,
      uploadInfo: [{
        fileInfo: {
          fileSize: ptt.fileSize,
          fileHash: ptt.md5Hex,
          fileSha1: ptt.sha1Hex,
          fileName: ptt.fileName,
          type: { type: 3, picFormat: 0, videoFormat: 0, voiceFormat: ptt.voiceFormat },
          width: 0,
          height: 0,
          time: ptt.duration,
          original: 0,
        },
        subFileType: 0,
      }],
      compatQmsgSceneType: isGroup ? 2 : 1,
      extBizInfo: {
        // NapCat fills in a placeholder textSummary so the legacy compat
        // QMsg path still has something to render. Mirror it.
        pic: { textSummary: 'Nya~' },
        video: { bytesPbReserve: new Uint8Array(0) },
        ptt: {
          bytesReserve: new Uint8Array([0x08, 0x00, 0x38, 0x00]),
          bytesPbReserve: new Uint8Array(0),
          // `bytesGeneralFlags` differs between group / c2c voice. Lifted
          // verbatim from NapCat (UploadGroupPtt.ts / UploadPrivatePtt.ts).
          bytesGeneralFlags: isGroup
            ? new Uint8Array([0x9a, 0x01, 0x07, 0xaa, 0x03, 0x04, 0x08, 0x08, 0x12, 0x00])
            : new Uint8Array([0x9a, 0x01, 0x0b, 0xaa, 0x03, 0x08, 0x08, 0x04, 0x12, 0x04, 0x00, 0x00, 0x00, 0x00]),
        },
      },
      uploads,
      label: 'ptt',
    });

    return finalizeMediaMsgInfo(upload);
  } finally {
    for (const fn of ptt.cleanups) {
      try { fn(); } catch { /* best-effort cleanup */ }
    }
  }
}
