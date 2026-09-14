import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  NTV2ExtBizInfo,
  NTV2UploadInfo,
  NTV2UploadRespBody,
  NTV2UploadRichMediaReq,
  NTV2UploadRichMediaResp,
} from '@snowluma/proto-defs/highway';
import { invokeOidb, type OidbSender } from '../../oidb-service';

/**
 * NTV2 rich-media upload preflight. Image / PTT / video share one Req/Resp
 * type; command (0x11C4 / 0x11C5 / …) comes from the caller. Highway PUTs
 * stay in the pipeline.
 */
export namespace Ntv2UploadRequest {
  export const command = 0;
  export const subCommand = 100;
  export const uinForm = true;

  export interface Params {
    oidbCmd: number;
    isGroup: boolean;
    targetIdOrUid: string | number;
    requestId: number;
    businessType: number;
    uploadInfo: NTV2UploadInfo[];
    compatQmsgSceneType: number;
    extBizInfo: NTV2ExtBizInfo;
    tryFast: boolean;
    clientRandomId: bigint;
    label?: string;
  }

  export type Deps = OidbSender;

  export const resolveCommand = (params: Params): number => params.oidbCmd;

  export const serialize = (_ctx: Deps, params: Params): NTV2UploadRichMediaReq => ({
    reqHead: {
      common: { requestId: params.requestId, command: 100 },
      scene: {
        requestType: 2,
        businessType: params.businessType,
        sceneType: params.isGroup ? 2 : 1,
        ...(params.isGroup
          ? { group: { groupUin: Number(params.targetIdOrUid) } }
          : { c2c: { accountType: 2, targetUid: String(params.targetIdOrUid) } }),
      },
      client: { agentType: 2 },
    },
    upload: {
      uploadInfo: params.uploadInfo,
      tryFastUploadCompleted: params.tryFast,
      srvSendMsg: false,
      clientRandomId: params.clientRandomId,
      compatQmsgSceneType: params.compatQmsgSceneType,
      extBizInfo: params.extBizInfo,
      clientSeq: 0,
      noNeedCompatMsg: false,
    },
  });

  export const deserializeUpload = (body: NTV2UploadRichMediaResp, label = 'media'): NTV2UploadRespBody => {
    if (!body) throw new Error(`${label} upload response body missing`);
    if (body.respHead?.retCode && body.respHead.retCode !== 0) {
      throw new Error(body.respHead.message ?? `${label} upload failed`);
    }
    const upload = body.upload;
    if (!upload) throw new Error(`${label} upload response body missing`);
    if (!upload.msgInfo) throw new Error('upload response missing msgInfo');
    return upload;
  };

  export const deserialize = (_ctx: Deps, body: NTV2UploadRichMediaResp): NTV2UploadRespBody =>
    deserializeUpload(body);

  export const encode = (env: OidbBase<NTV2UploadRichMediaReq>): Uint8Array =>
    protobuf_encode<OidbBase<NTV2UploadRichMediaReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<NTV2UploadRichMediaResp> =>
    protobuf_decode<OidbBase<NTV2UploadRichMediaResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<NTV2UploadRespBody> =>
    invokeOidb(deps, {
      ...Ntv2UploadRequest,
      deserialize: (_ctx, body) => deserializeUpload(body, params.label ?? 'media'),
    }, params);
}
