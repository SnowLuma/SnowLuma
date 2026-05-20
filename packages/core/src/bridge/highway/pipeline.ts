import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import crypto from 'crypto';
import { createLogger } from '../../utils/logger';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope } from '../bridge-oidb';
import type {
  EncodableMediaMsgInfo,
  NTV2UploadRichMediaReq,
  NTV2UploadRichMediaResp,
} from '@snowluma/proto-defs/highway';
import { OidbBase } from '@snowluma/proto-defs/oidb';
import { buildHighwayExtend, fetchHighwaySession, uploadHighwayHttp } from './highway-client';

const moduleLog = createLogger('Highway');

// ─────────────── public types ───────────────

/**
 * Highway upload spec for one sub-file of an NTV2 upload response.
 * The server returns 0..N sub-files; for each we either fast-path (skip)
 * or do an HTTP PUT.
 */
export interface MediaSubFileUpload {
  /**
   * Where to read uKey + ipv4s from on the OIDB response:
   *   'top'    -> `upload.uKey`             + `upload.ipv4s`           (main file)
   *   N (int)  -> `upload.subFileInfos[N].uKey` + `.ipv4s`             (sub-file)
   *
   * Image and PTT use 'top' only. Video uses 'top' (main) and 0 (thumb).
   */
  source: 'top' | number;
  /** Highway command id for this sub-file. */
  cmdId: number;
  /** Bytes to upload. Empty when the caller is forwarding from cached
   *  fingerprints; in that case set fastOnlyError so we throw with a
   *  typed message when the server actually demands the bytes. */
  bytes: Uint8Array;
  /** md5 used for the highway request. */
  md5: Uint8Array;
  /** sha1 — single buffer or per-1MB block array. Passed verbatim to
   *  buildHighwayExtend. */
  sha1: Uint8Array | Uint8Array[];
  /** subFileIndex argument for buildHighwayExtend. Defaults to 0;
   *  video thumb passes 1. */
  subFileIndex?: number;
  /** Error message to throw when uKey is present but `bytes.length === 0`.
   *  Omit if the caller guarantees bytes always exist (e.g. video thumb
   *  always has FALLBACK_THUMB bytes). */
  fastOnlyError?: string;
}

export interface NtV2UploadParams {
  bridge: Bridge;
  isGroup: boolean;
  /** Group uin when isGroup, otherwise the recipient's uid string. */
  targetIdOrUid: string | number;
  /** OIDB command id (e.g. 0x11C4 / 0x11C5 / 0x126E / 0x126D / 0x11EA / 0x11E9). */
  oidbCmd: number;
  /** Service cmd (e.g. 'OidbSvcTrpcTcp.0x11c4_100'). */
  serviceCmd: string;
  /** `reqHead.common.requestId`. NTV2 sub-protocols use different values
   *  here (image=1, video=3, ptt = group:1 / c2c:4). */
  requestId: number;
  /** `reqHead.scene.businessType` (1=image, 3=voice, 2=video). */
  businessType: number;
  /** `upload.uploadInfo` array. Each entry is `{ fileInfo, subFileType }`. */
  uploadInfo: unknown[];
  /** `upload.compatQmsgSceneType`. */
  compatQmsgSceneType: number;
  /** `upload.extBizInfo` — type-specific bytes/flags. */
  extBizInfo: unknown;
  /** Sub-file Highway PUTs to perform after the OIDB response. */
  uploads: MediaSubFileUpload[];
  /** Used in error messages. Defaults to 'media'. */
  label?: string;
}

// ─────────────── helpers ───────────────

/**
 * 8 random bytes masked into the positive int64 range so the resulting
 * BigInt survives signed-int64 protobuf encoding without surprises.
 * Mirrors NapCat.
 */
export function makeClientRandomId(): bigint {
  const buf = crypto.randomBytes(8);
  return buf.readBigUInt64BE() & 0x7FFFFFFFFFFFFFFFn;
}

/** Hex string -> Uint8Array. Used by every format's fingerprint path. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : '0' + hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─────────────── main entrypoint ───────────────

/**
 * Send a NTV2UploadRichMediaReq and run any Highway PUTs the server asks
 * for. Returns the decoded `upload` object so the caller can pass it to
 * `finalizeMediaMsgInfo`.
 *
 * Sessions are cached across sub-file uploads — video does two PUTs but
 * only fetches the Highway session once.
 */
export async function runNtv2Upload(params: NtV2UploadParams): Promise<any> {
  const { bridge, isGroup, targetIdOrUid, oidbCmd, serviceCmd, uploads } = params;
  const label = params.label ?? 'media';
  const raw = bridge.identity?.uin;
  const uinNum = typeof raw === 'string' ? Number.parseInt(raw, 10) : 0;
  const log = Number.isFinite(uinNum) && uinNum > 0
    ? moduleLog.child({ uin: uinNum })
    : moduleLog;

  // Build the full body once. Pulling this in here means each format file
  // only specifies the seven fields that actually vary.
  const body: any = {
    reqHead: {
      common: { requestId: params.requestId, command: 100 },
      scene: {
        requestType: 2,
        businessType: params.businessType,
        sceneType: isGroup ? 2 : 1,
        ...(isGroup
          ? { group: { groupUin: Number(targetIdOrUid) } }
          : { c2c: { accountType: 2, targetUid: String(targetIdOrUid) } }),
      },
      client: { agentType: 2 },
    },
    upload: {
      uploadInfo: params.uploadInfo,
      tryFastUploadCompleted: true,
      srvSendMsg: false,
      clientRandomId: makeClientRandomId(),
      compatQmsgSceneType: params.compatQmsgSceneType,
      extBizInfo: params.extBizInfo,
      clientSeq: 0,
      noNeedCompatMsg: false,
    },
  };

  const env = makeOidbEnvelope<NTV2UploadRichMediaReq>(oidbCmd, 100, body, true);
  const requestBytes = protobuf_encode<OidbBase<NTV2UploadRichMediaReq>>(env);

  const result = await bridge.sendRawPacket(serviceCmd, requestBytes);
  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || `${label} upload request failed`);
  }

  const resp = protobuf_decode<OidbBase<NTV2UploadRichMediaResp>>(result.responseData);
  if (!resp) throw new Error(`failed to decode ${label} upload response`);
  if (resp.errorCode && resp.errorCode !== 0) {
    throw new Error(`OIDB error ${resp.errorCode}: ${resp.errorMsg ?? ''}`);
  }

  const uploadBody: any = resp.body;
  if (!uploadBody) throw new Error(`${label} upload response body missing`);
  if (uploadBody.respHead?.retCode && uploadBody.respHead.retCode !== 0) {
    throw new Error(uploadBody.respHead.message ?? `${label} upload failed`);
  }
  const upload = uploadBody.upload;
  if (!upload) throw new Error(`${label} upload response body missing`);

  // Highway PUTs. Session is lazily fetched and cached — video does two
  // PUTs (main + thumb) and shouldn't pay for two sessions.
  let session: Awaited<ReturnType<typeof fetchHighwaySession>> | null = null;
  const getSession = async () => {
    session ??= await fetchHighwaySession(bridge);
    return session;
  };

  let didPut = false;
  for (const sub of uploads) {
    const target = sub.source === 'top' ? upload : upload.subFileInfos?.[sub.source];
    const uKey = target?.uKey ?? '';
    // Either the server fast-pathed this sub-file (no uKey) or msgInfo is
    // missing entirely; either way nothing to push.
    if (!uKey || !upload.msgInfo) continue;

    if (sub.bytes.length === 0) {
      if (sub.fastOnlyError) throw new Error(sub.fastOnlyError);
      continue;
    }

    const extend = buildHighwayExtend(
      uKey,
      upload.msgInfo,
      target.ipv4s ?? [],
      sub.sha1 as any, // sha1 may be Uint8Array | Uint8Array[]; the helper accepts both
      sub.subFileIndex ?? 0,
    );
    log.debug('%s OIDB requires bytes, PUT %d bytes (sub=%s)', label, sub.bytes.length, String(sub.source));
    const t0 = Date.now();
    await uploadHighwayHttp(bridge, await getSession(), sub.cmdId, sub.bytes, sub.md5, extend);
    log.debug('%s PUT done in %dms', label, Date.now() - t0);
    didPut = true;
  }

  if (!didPut) {
    log.debug('%s fast-upload hit (server already had bytes)', label);
  }

  return upload;
}

// ─────────────── shared finalize ───────────────

/**
 * Build the encoded MsgInfo bytes that go inside the outgoing commonElem.
 *
 * `defaultPic` is the image-only fall-back: image uploads inject
 * `bizType` + `textSummary` defaults when the server response omits the
 * `pic` ext-biz-info. PTT and video pass `undefined` here — they leave
 * pic alone unless the server populates it.
 */
export function finalizeMediaMsgInfo(
  upload: any,
  defaultPic?: { bizType: number; textSummary: string },
): Uint8Array {
  if (!upload?.msgInfo) throw new Error('upload response missing msgInfo');

  const msgInfoBody = (upload.msgInfo.msgInfoBody ?? []).map((b: any) => ({
    index: b.index, picture: b.picture, fileExist: b.fileExist, hashSum: b.hashSum,
  }));

  const extBizInfo: any = {};
  if (upload.msgInfo.extBizInfo?.pic) {
    extBizInfo.pic = { ...upload.msgInfo.extBizInfo.pic };
    if (defaultPic) {
      extBizInfo.pic.bizType = extBizInfo.pic.bizType ?? defaultPic.bizType;
      extBizInfo.pic.textSummary = extBizInfo.pic.textSummary ?? defaultPic.textSummary;
    }
  } else if (defaultPic) {
    extBizInfo.pic = { bizType: defaultPic.bizType, textSummary: defaultPic.textSummary };
  }
  if (upload.msgInfo.extBizInfo?.video) extBizInfo.video = upload.msgInfo.extBizInfo.video;
  if (upload.msgInfo.extBizInfo?.ptt) extBizInfo.ptt = upload.msgInfo.extBizInfo.ptt;
  if (upload.msgInfo.extBizInfo?.busiType !== undefined) {
    extBizInfo.busiType = upload.msgInfo.extBizInfo.busiType;
  }

  return protobuf_encode<EncodableMediaMsgInfo>({ msgInfoBody, extBizInfo });
}
