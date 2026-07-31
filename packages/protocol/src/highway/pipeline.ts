import {
  createLogger,
  renderTraceBytes,
  runWithTraceRequest,
} from '@snowluma/common/logger';
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
import { BufferChunkSource, FileChunkSource, buildHighwayExtend, fetchHighwaySession, uploadHighwayHttp } from './highway-client';

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
   *  typed message when the server actually demands the bytes. Also empty
   *  when `fileSource` is set (the bytes are streamed from disk instead). */
  bytes: Uint8Array;
  /** When set, this sub-file streams from a disk file instead of `bytes`
   *  (which should be empty). runPuts opens a `FileChunkSource`; all size /
   *  data-presence decisions use `fileSource.fileSize`, not `bytes.length`. */
  fileSource?: { filePath: string; fileSize: number };
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

function sha1TraceValue(value: Uint8Array | Uint8Array[]): string {
  const values = Array.isArray(value) ? value : [value];
  return `[${values.map((item) => renderTraceBytes(item)).join(',')}]`;
}

function uploadDescriptors(uploads: MediaSubFileUpload[]): string {
  return `[${uploads.map((sub) => [
    `source:${JSON.stringify(String(sub.source))}`,
    `cmdId:${sub.cmdId}`,
    `size:${sub.fileSource ? sub.fileSource.fileSize : sub.bytes.byteLength}`,
    `storage:${JSON.stringify(sub.fileSource ? 'disk' : 'buffer')}`,
    `md5:${renderTraceBytes(sub.md5)}`,
    `sha1:${sha1TraceValue(sub.sha1)}`,
    `subFileIndex:${sub.subFileIndex ?? 0}`,
  ].join(',')).join(';')}]`;
}

function mediaErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
export function runNtv2Upload(params: NtV2UploadParams): Promise<NTV2UploadRespBody> {
  const startedAt = Date.now();
  const label = params.label ?? 'media';
  let failureReason = 'unexpected_failure';
  let didPut = false;
  return runWithTraceRequest(async () => {
    moduleLog.trace(() => [
      'highway_media_start label=%j scope=%s target=%j oidbCmd=%d serviceCmd=%j requestId=%d businessType=%d uploads=%s',
      label,
      params.isGroup ? 'group' : 'private',
      String(params.targetIdOrUid),
      params.oidbCmd,
      params.serviceCmd,
      params.requestId,
      params.businessType,
      uploadDescriptors(params.uploads),
    ]);
    try {
      const result = await runNtv2UploadOperation(params, (reason, put) => {
        failureReason = reason;
        if (put !== undefined) didPut = put;
      });
      moduleLog.trace(
        'highway_media_terminal label=%j outcome=completed reason=%s uploads=%d elapsedMs=%d',
        label,
        didPut ? 'put_complete' : 'fast_upload',
        params.uploads.length,
        Date.now() - startedAt,
      );
      return result;
    } catch (error) {
      moduleLog.trace(() => [
        'highway_media_terminal label=%j outcome=failed reason=%s uploads=%d error=%j elapsedMs=%d',
        label,
        failureReason,
        params.uploads.length,
        mediaErrorText(error),
        Date.now() - startedAt,
      ]);
      throw error;
    }
  });
}

async function runNtv2UploadOperation(
  params: NtV2UploadParams,
  setState: (failureReason: string, didPut?: boolean) => void,
): Promise<NTV2UploadRespBody> {
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

    setState('request_failed');
    const result = await bridge.sendRawPacket(serviceCmd, requestBytes);
    log.trace(() => [
      'highway_media_branch branch=oidb_response success=%s gotResponse=%s errorCode=%d errorMessage=%j responseBytes=%d',
      result.success,
      result.gotResponse,
      result.errorCode,
      result.errorMessage ?? '',
      result.responseData?.byteLength ?? 0,
    ]);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(result.errorMessage || `${label} upload request failed`);
    }

    setState('response_decode_failed');
    const resp = protobuf_decode<OidbBase<NTV2UploadRichMediaResp>>(result.responseData);
    if (!resp) throw new Error(`failed to decode ${label} upload response`);
    if (resp.errorCode && resp.errorCode !== 0) {
      setState('oidb_rejected');
      throw new Error(`OIDB error ${resp.errorCode}: ${resp.errorMsg ?? ''}`);
    }

    const uploadBody = resp.body;
    setState('response_invalid');
    if (!uploadBody) throw new Error(`${label} upload response body missing`);
    if (uploadBody.respHead?.retCode && uploadBody.respHead.retCode !== 0) {
      setState('business_rejected');
      throw new Error(uploadBody.respHead.message ?? `${label} upload failed`);
    }
    const upload = uploadBody.upload;
    if (!upload) throw new Error(`${label} upload response body missing`);
    if (!upload.msgInfo) throw new Error('upload response missing msgInfo');
    return upload;
  };

  // Highway PUTs. Session is lazily fetched and cached — video does two
  // PUTs (main + thumb) and shouldn't pay for two sessions, and a forced
  // retry shouldn't re-fetch it either.
  let session: Awaited<ReturnType<typeof fetchHighwaySession>> | null = null;
  const getSession = async () => {
    setState('session_failed');
    session ??= await fetchHighwaySession(bridge);
    return session;
  };

  // Run whatever PUTs the given `upload` response asks for.
  const runPuts = async (upload: NTV2UploadRespBody): Promise<void> => {
    const msgInfo = upload.msgInfo;
    if (!msgInfo) throw new Error('upload response missing msgInfo');
    let didPut = false;
    for (const sub of uploads) {
      const target = sub.source === 'top' ? upload : upload.subFileInfos?.[sub.source];
      const uKey = target?.uKey ?? '';
      // Data size / presence comes from fileSource (streamed) when set, else
      // from the in-memory bytes — a streamed sub-file has empty `bytes`, so
      // keying the checks below on `bytes.length` would wrongly treat it as a
      // fast-only / empty sub-file.
      const subSize = sub.fileSource ? sub.fileSource.fileSize : sub.bytes.length;
      // No uKey: the server fast-pathed this sub-file — it already holds
      // (or claims to hold) the resource, so there are no bytes to push.
      if (!uKey) {
        if (subSize > 0) {
          log.trace(
            'highway_media_branch branch=fast_upload source=%j cmdId=%d size=%d',
            String(sub.source),
            sub.cmdId,
            subSize,
          );
          log.debug('%s fast-upload hit for sub=%s (server reusing cached resource)', label, String(sub.source));
        }
        continue;
      }

      if (subSize === 0) {
        log.trace(
          'highway_media_branch branch=empty_source source=%j cmdId=%d hasFastOnlyError=%s',
          String(sub.source),
          sub.cmdId,
          Boolean(sub.fastOnlyError),
        );
        if (sub.fastOnlyError) {
          setState('source_unavailable');
          throw new Error(sub.fastOnlyError);
        }
        continue;
      }

      if (!target) continue;

      log.trace(
        'highway_media_branch branch=put_required source=%j cmdId=%d size=%d uKey=%j storage=%s',
        String(sub.source),
        sub.cmdId,
        subSize,
        uKey,
        sub.fileSource ? 'disk' : 'buffer',
      );
      setState('extend_build_failed');
      const extend = buildHighwayExtend(
        uKey,
        msgInfo,
        target.ipv4s ?? [],
        sub.sha1,
        sub.subFileIndex ?? 0,
      );
      // Resolve the (lazy, cached) session BEFORE opening the ChunkSource, so
      // there is no fallible await between opening the FileChunkSource handle
      // and the uploadHighwayHttp call that owns closing it — otherwise a
      // session-fetch failure on the first PUT would leak the open handle.
      const putSession = await getSession();
      // uploadHighwayHttp owns the ChunkSource and closes it exactly once.
      setState('source_open_failed');
      const chunkSource = sub.fileSource
        ? await FileChunkSource.open(sub.fileSource.filePath, sub.fileSource.fileSize)
        : new BufferChunkSource(sub.bytes);
      log.debug('%s OIDB requires bytes, PUT %d bytes (sub=%s)', label, subSize, String(sub.source));
      const t0 = Date.now();
      setState('put_failed');
      await uploadHighwayHttp(bridge, putSession, sub.cmdId, chunkSource, sub.md5, extend);
      log.debug('%s PUT done in %dms', label, Date.now() - t0);
      didPut = true;
      setState('unexpected_failure', true);
    }

    if (!didPut) {
      log.debug('%s fast-upload hit (server already had bytes)', label);
    }
  };

  // NOTE: a previous attempt re-issued the request with
  // `tryFastUploadCompleted: false` when the server fast-pathed the main video,
  // on the theory it would force a fresh upload of a possibly-expired resource.
  // Real-machine testing + kernel RE proved that ineffective — the server's
  // fast-path is driven by md5-metadata existence and ignores the flag, and the
  // QQ NT kernel itself does no validity check either (HandleRspUploadV3 trusts
  // `fileExist` and reports success). An expired-but-still-indexed video
  // resource is a platform-level limitation, not something the upload flow can
  // refresh. See #145.
  const upload = await requestUpload(true);
  await runPuts(upload);
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
