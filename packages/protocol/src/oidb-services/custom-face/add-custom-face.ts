// Faceroam add — 添加收藏表情（custom face）：BDHExpressionRoam 申请 → highway HTTP 上传。
//
// 走的是 trpc service "ImgStore.BDHExpressionRoam"（不是 OIDB），申请上传
// 拿到 token，然后把图片数据打成 highway 帧用 HTTP POST 发到
// httpconn?htcmd=0x6FF0087。上传节点 host:port 复用 fetchHighwaySession
// （0x6ff_501）的 serverInfos，端口 80。
//
// head segHead.serviceTicket = BDHExpressionRoam 响应 token（不是 sigSession，
// 端到端验证过）。head field5 (82B) 抓包见过但非必需，不填也能上传。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  BDHExpressionRoamReq,
  BDHExpressionRoamResp,
  FavEmojiHighwayHead,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { BridgeContext } from '../../bridge-context';
import { fetchHighwaySession } from '../../highway/highway-client';
import { computeMd5, packHighwayFrame } from '../../highway/utils';

export namespace AddCustomFace {
  const BDH_SERVICE = 'ImgStore.BDHExpressionRoam';

  export interface Params {
    uin: string;
    imageBytes: Uint8Array;
  }

  // fetchHighwaySession 需要 sendRawPacket + identity，所以 Deps 比纯 OidbSender 多 identity。
  export type Deps = Pick<BridgeContext, 'sendRawPacket' | 'identity'>;

  function md5Hex(md5: Uint8Array): string {
    let s = '';
    for (const b of md5) s += b.toString(16).padStart(2, '0');
    return s;
  }

  export async function invoke(deps: Deps, params: Params): Promise<string> {
    const { uin, imageBytes } = params;
    const md5 = computeMd5(imageBytes);
    const emojiId = `${uin}_0_0_0_${md5Hex(md5).toUpperCase()}_0_0`;

    // 1. fetchHighwaySession 拿上传节点 host:port（复用 SnowLuma highway-client）
    const session = await fetchHighwaySession(deps as unknown as BridgeContext);
    const host = session.host;
    const port = session.port;

    // 2. BDHExpressionRoam 申请上传 token
    const reqBody = protobuf_encode<BDHExpressionRoamReq>({
      field1: 3,
      field2: 1,
      inner: {
        field1: 0,
        uin: BigInt(uin),
        field3: 0,
        md5,
        filesize: imageBytes.length,
        field7: 2,
        field8: 0,
        field9: 1,
        ver: '1.0.0',
        field16: 1,
      },
      field7: 9,
      tail: { inner: { field1: 0, field2: 0, field3: '0' }, field2: 1 },
    });
    const result = await deps.sendRawPacket(BDH_SERVICE, reqBody);
    if (!result.gotResponse) throw new Error(result.errorMessage || 'BDHExpressionRoam: no response');
    if (!result.success) throw new Error(result.errorMessage || 'BDHExpressionRoam: send failed');
    const resp = protobuf_decode<BDHExpressionRoamResp>(result.responseData ?? new Uint8Array(0));
    const token = resp.inner?.token;
    if (!token) throw new Error('BDHExpressionRoam: response missing token (field8)');

    // 3. 构造 highway head。serviceTicket = BDHExpressionRoam token。
    const head = protobuf_encode<FavEmojiHighwayHead>({
      baseHead: {
        version: 1,
        uin,
        command: 'PicUp.DataUp',
        seq: 1,
        retryTimes: 0,
        filesize: BigInt(imageBytes.length),
        dataFlag: 16,
        commandId: 9,
      },
      segHead: {
        serviceId: 0,
        filesize: BigInt(imageBytes.length),
        dataOffset: 0n,
        dataLength: BigInt(imageBytes.length),
        serviceTicket: token,
        md5,
        fileMd5: md5,
      },
      emojiIdWrap: { emojiId },
      field4: 0,
      field8: 9,
      // field5 (82B) 抓包见过但非必需，不填
    });

    // 4. highway 帧（复用 SnowLuma packHighwayFrame，结构和抓包一致）
    const frame = packHighwayFrame(head, imageBytes);

    // 5. HTTP POST 上传。端口用 fetchHighwaySession 的 port（抓包确认 httpconn 端口 80）。
    const url = `http://${host}:${port}/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${uin}`;
    const httpResp = await fetch(url, {
      method: 'POST',
      body: frame,
      headers: {
        Accept: '*/*',
        Connection: 'Keep-Alive',
        'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
    if (!httpResp.ok) throw new Error(`highway upload failed: HTTP ${httpResp.status}`);

    return emojiId;
  }
}
