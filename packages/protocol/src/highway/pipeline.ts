import { createLogger } from '@snowluma/common/logger';
import type {
  EncodableMediaMsgInfo,
  HighwayMsgInfoBody,
  NTV2ExtBizInfo,
  NTV2UploadInfo,
  NTV2UploadRespBody,
  NTV2UploadRichMediaReq,
  NTV2UploadRichMediaResp,
} from '@snowluma/proto-defs/highway';
import { OidbBase } from '@snowluma/proto-defs/oidb';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import crypto from 'crypto';
import type { BridgeContext } from '../bridge-context';
import { makeOidbEnvelope } from '../bridge-oidb';
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
  /** When true and the server fast-paths THIS sub-file (returns no uKey)
   *  even though we hold real bytes for it, `runNtv2Upload` re-issues the
   *  whole OIDB request with `tryFastUploadCompleted: false` to force a
   *  fresh full upload. Video sets this on the main file: group/c2c video
   *  resources expire server-side, so a fast-path hit can reference a
   *  stale object the receiver renders as "资源已过期". The thumb leaves
   *  this off — a cached thumb is harmless and not worth re-pushing the
   *  whole (potentially 100 MB) main video for. Forwarding paths carry no
   *  bytes (`bytes.length === 0`), so this never fires for them. */
  forceFullOnFastPath?: boolean;
}

export interface NtV2UploadParams {
  bridge: BridgeContext;
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
  uploadInfo: NTV2UploadInfo[];
  /** `upload.compatQmsgSceneType`. */
  compatQmsgSceneType: number;
  /** `upload.extBizInfo` — type-specific bytes/flags. */
  extBizInfo: NTV2ExtBizInfo;
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
export async function runNtv2Upload(params: NtV2UploadParams): Promise<NTV2UploadRespBody> {
  const { bridge, isGroup, targetIdOrUid, oidbCmd, serviceCmd, uploads } = params;
  const label = params.label ?? 'media';
  const raw = bridge.identity?.uin;
  const uinNum = typeof raw === 'string' ? Number.parseInt(raw, 10) : 0;
  const log = Number.isFinite(uinNum) && uinNum > 0
    ? moduleLog.child({ uin: uinNum })
    : moduleLog;

  // Send one OIDB request and return its decoded `upload` body. `tryFast`
  // toggles `tryFastUploadCompleted`: true asks the server to reuse a
  // cached resource (skip the bytes); false forces it to allocate a fresh
  // upload session and hand back a uKey. NOTE: proton only emits a plain
  // `pb<bool>` when it's `true`, so `tryFast === false` omits field 2 —
  // the server reads that as "don't fast-upload" (the opt-in default).
  const requestUpload = async (tryFast: boolean): Promise<NTV2UploadRespBody> => {
    const body: NTV2UploadRichMediaReq = {
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
        tryFastUploadCompleted: tryFast,
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

    const uploadBody = resp.body;
    if (!uploadBody) throw new Error(`${label} upload response body missing`);
    if (uploadBody.respHead?.retCode && uploadBody.respHead.retCode !== 0) {
      throw new Error(uploadBody.respHead.message ?? `${label} upload failed`);
    }
    const upload = uploadBody.upload;
    if (!upload) throw new Error(`${label} upload response body missing`);
    return upload;
  };

  // Highway PUTs. Session is lazily fetched and cached — video does two
  // PUTs (main + thumb) and shouldn't pay for two sessions, and a forced
  // retry shouldn't re-fetch it either.
  let session: Awaited<ReturnType<typeof fetchHighwaySession>> | null = null;
  const getSession = async () => {
    session ??= await fetchHighwaySession(bridge);
    return session;
  };

  // Run whatever PUTs the given `upload` response asks for. Returns true
  // when a sub-file flagged `forceFullOnFastPath` was fast-pathed by the
  // server (no uKey) while we hold real bytes for it — the caller uses
  // that to force a non-fast-upload retry.
  const runPuts = async (upload: NTV2UploadRespBody): Promise<boolean> => {
    let didPut = false;
    let staleFastPath = false;
    for (const sub of uploads) {
      const target = sub.source === 'top' ? upload : upload.subFileInfos?.[sub.source];
      const uKey = target?.uKey ?? '';
      // No uKey: the server fast-pathed this sub-file (or msgInfo is absent
      // entirely). When we actually hold bytes for it, the server is
      // reusing a cached resource — surface it, and flag a stale fast-path
      // when the caller asked us to distrust it for this sub-file.
      if (!uKey || !upload.msgInfo) {
        if (!uKey && upload.msgInfo && sub.bytes.length > 0) {
          log.debug('%s fast-upload hit for sub=%s (server reusing cached resource)', label, String(sub.source));
          if (sub.forceFullOnFastPath) staleFastPath = true;
        }
        continue;
      }

      if (sub.bytes.length === 0) {
        if (sub.fastOnlyError) throw new Error(sub.fastOnlyError);
        continue;
      }

      if (!target) continue;

      const extend = buildHighwayExtend(
        uKey,
        upload.msgInfo,
        target.ipv4s ?? [],
        sub.sha1,
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
    return staleFastPath;
  };

  let upload = await requestUpload(true);
  const staleFastPath = await runPuts(upload);

  // A flagged sub-file (video main) was fast-pathed to a server resource
  // that may have expired. Re-issue without fast-upload so the server
  // allocates a fresh resource and demands the bytes, then redo the PUTs
  // against that response — the returned `upload` (and its msgInfo) must
  // be the one we actually pushed bytes to.
  if (staleFastPath) {
    log.debug('%s forcing full upload — fast-path resource may be stale/expired', label);
    upload = await requestUpload(false);
    const stillFastPathed = await runPuts(upload);
    if (stillFastPathed) {
      log.debug('%s server still fast-pathed after forcing full upload — resource may remain stale', label);
    }
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
  upload: NTV2UploadRespBody,
  defaultPic?: { bizType: number; textSummary: string },
): Uint8Array {
  if (!upload?.msgInfo) throw new Error('upload response missing msgInfo');

  const msgInfoBody = (upload.msgInfo.msgInfoBody ?? []).map((b: HighwayMsgInfoBody) => ({
    index: b.index, picture: b.picture, fileExist: b.fileExist, hashSum: b.hashSum,
  }));

  const extBizInfo: NonNullable<EncodableMediaMsgInfo['extBizInfo']> = {};
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
