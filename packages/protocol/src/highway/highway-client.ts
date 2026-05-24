import type {
  HighwayMsgInfoBody,
  HttpConn0x6FF501Request,
  HttpConn0x6FF501Response,
  NTV2IPv4,
  NTV2RichMediaHighwayExt,
  NTV2UploadRespMsgInfo,
  ReqDataHighwayHead,
  RespDataHighwayHead,
} from '@snowluma/proto-defs/highway';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import net from 'net';
import type { BridgeContext } from '../bridge-context';
import { computeMd5, packHighwayFrame, unpackHighwayFrame } from './utils';

const HIGHWAY_APP_ID = 1600001604;
const HIGHWAY_BLOCK_SIZE = 1024 * 1024;

export const PRIVATE_IMAGE_CMD_ID = 1003;
export const GROUP_IMAGE_CMD_ID = 1004;

export interface HighwaySession {
  sigSession: Uint8Array;
  sessionKey: Uint8Array;
  host: string;
  port: number;
}

function ipv4ToString(value: number): string {
  return `${value & 0xFF}.${(value >> 8) & 0xFF}.${(value >> 16) & 0xFF}.${(value >> 24) & 0xFF}`;
}

export async function fetchHighwaySession(bridge: BridgeContext): Promise<HighwaySession> {
  const request = protobuf_encode<HttpConn0x6FF501Request>({
    httpConn: {
      field1: 0, field2: 0, field3: 16, field4: 1, field6: 3,
      serviceTypes: [1, 5, 10, 21],
      field9: 2, field10: 9, field11: 8, ver: '1.0.1',
    },
  });

  const result = await bridge.sendRawPacket('HttpConn.0x6ff_501', request);
  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'HttpConn request failed');
  }

  const resp = protobuf_decode<HttpConn0x6FF501Response>(result.responseData);
  if (!resp?.httpConn) throw new Error('HttpConn response body missing');
  if (!resp.httpConn.sigSession || (resp.httpConn.sigSession as Uint8Array).length === 0) {
    throw new Error('HttpConn response missing sig_session');
  }

  const session: HighwaySession = {
    sigSession: resp.httpConn.sigSession as Uint8Array,
    sessionKey: (resp.httpConn.sessionKey as Uint8Array) ?? new Uint8Array(0),
    host: 'htdata3.qq.com',
    port: 80,
  };

  for (const si of resp.httpConn.serverInfos ?? []) {
    if ((si.serviceType ?? 0) !== 1 || !si.serverAddrs?.length) continue;
    for (const addr of si.serverAddrs) {
      const ip = addr.ip ?? 0;
      const port = addr.port ?? 0;
      if (ip && port) {
        session.host = ipv4ToString(ip);
        session.port = port;
      }
    }
  }

  console.log(`[Highway] session: ${session.host}:${session.port} sig=${(session.sigSession as Uint8Array).length}B`);
  return session;
}

function makeHighwayHead(
  uin: string, commandId: number, fileSize: number, offset: number, length: number,
  chunkMd5: Uint8Array, fileMd5: Uint8Array, sigSession: Uint8Array, extend: Uint8Array,
): Uint8Array {
  return protobuf_encode<ReqDataHighwayHead>({
    msgBaseHead: {
      version: 1, uin, command: 'PicUp.DataUp', seq: 0, retryTimes: 0,
      appId: HIGHWAY_APP_ID, dataFlag: 16, commandId,
    },
    msgSegHead: {
      serviceId: 0, filesize: BigInt(fileSize), dataOffset: BigInt(offset), dataLength: length,
      retCode: 0, serviceTicket: sigSession, flag: 0, md5: chunkMd5, fileMd5, cacheAddr: 0, cachePort: 0,
    },
    bytesReqExtendInfo: extend,
    timestamp: 0n,
    msgLoginSigHead: { loginSigType: 8, appId: HIGHWAY_APP_ID },
  });
}

export function buildHighwayExtend(
  uKey: string,
  msgInfo: NTV2UploadRespMsgInfo,
  ipv4s: NTV2IPv4[],
  sha1: Uint8Array | Uint8Array[],
  fileIndex = 0,
): Uint8Array {
  const msgInfoBody = msgInfo?.msgInfoBody ?? [];
  if (msgInfoBody.length === 0) throw new Error('upload response missing msg_info body');

  const selected = msgInfoBody[fileIndex] ?? msgInfoBody[0];
  const networkIpv4s: NonNullable<NonNullable<NTV2RichMediaHighwayExt['network']>['ipv4s']> = [];
  for (const ipv4 of ipv4s ?? []) {
    const ip = ipv4.outIp ?? 0;
    const port = ipv4.outPort ?? 0;
    if (ip && port) {
      networkIpv4s.push({ domain: { isEnable: true, ip: ipv4ToString(ip) }, port });
    }
  }

  return protobuf_encode<NTV2RichMediaHighwayExt>({
    fileUuid: selected?.index?.fileUuid ?? '',
    uKey,
    network: { ipv4s: networkIpv4s },
    msgInfoBody: msgInfoBody.map((b: HighwayMsgInfoBody) => ({
      index: b.index, picture: b.picture, fileExist: b.fileExist, hashSum: b.hashSum,
    })),
    blockSize: HIGHWAY_BLOCK_SIZE,
    hash: { fileSha1: Array.isArray(sha1) ? sha1 : [sha1] },
  });
}

// --- TCP-based HTTP highway upload ---

function tcpConnect(host: string, port: number, timeoutMs = 10000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onTimeout = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('TCP connect timeout'));
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const socket = net.createConnection({ host, port }, () => {
      if (settled) return;
      settled = true;
      // Drop the connect-only listeners so subsequent IO errors / idle
      // timeouts don't try to reject this already-resolved promise.
      socket.setTimeout(0);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('error', onError);
      resolve(socket);
    });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', onTimeout);
    socket.once('error', onError);
  });
}

function socketWrite(socket: net.Socket, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => err ? reject(err) : resolve());
  });
}

function readHttpResponseBody(socket: net.Socket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headerEnd = -1;
    let contentLength = 0;
    let totalNeeded = 0;
    let settled = false;

    const detach = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      detach();
      fn();
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (headerEnd < 0) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx >= 0) {
          headerEnd = idx + 4;
          const headerStr = buf.subarray(0, headerEnd).toString('ascii').toLowerCase();
          const clMatch = headerStr.match(/content-length:\s*(\d+)/);
          contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
          totalNeeded = headerEnd + contentLength;
        }
      }
      if (headerEnd >= 0 && buf.length >= totalNeeded) {
        finish(() => resolve(new Uint8Array(buf.subarray(headerEnd, totalNeeded))));
      }
    };
    const onError = (err: Error) => finish(() => reject(err));
    const onClose = () => finish(() => {
      const buf = Buffer.concat(chunks);
      if (headerEnd >= 0) resolve(new Uint8Array(buf.subarray(headerEnd)));
      else reject(new Error('connection closed before response'));
    });

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function httpPostFrame(
  socket: net.Socket, host: string, path: string, body: Uint8Array,
): Promise<Uint8Array> {
  const header = `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\nAccept-Encoding: identity\r\nUser-Agent: Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)\r\nContent-Length: ${body.length}\r\n\r\n`;
  await socketWrite(socket, Buffer.from(header, 'ascii'));
  if (body.length > 0) await socketWrite(socket, body);
  return readHttpResponseBody(socket);
}

export async function uploadHighwayHttp(
  bridge: BridgeContext, session: HighwaySession, commandId: number,
  bytes: Uint8Array, fileMd5: Uint8Array, extend: Uint8Array,
): Promise<void> {
  const pathStr = `/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${bridge.identity.uin}`;
  const socket = await tcpConnect(session.host, session.port);

  try {
    let offset = 0;
    while (offset < bytes.length) {
      const chunkSize = Math.min(HIGHWAY_BLOCK_SIZE, bytes.length - offset);
      const chunk = bytes.subarray(offset, offset + chunkSize);
      const chunkMd5 = computeMd5(chunk);
      const head = makeHighwayHead(
        bridge.identity.uin, commandId, bytes.length, offset, chunkSize,
        chunkMd5, fileMd5, session.sigSession, extend,
      );
      const frame = packHighwayFrame(head, chunk);
      const responseBody = await httpPostFrame(socket, session.host, pathStr, frame);
      const { head: respHead } = unpackHighwayFrame(responseBody);
      const resp = protobuf_decode<RespDataHighwayHead>(respHead);
      if (resp?.errorCode && resp.errorCode !== 0) {
        // Surface every diagnostic the highway response carries so
        // user reports of `error_code=921` and friends include the
        // server-side context (segHead.retCode, chunk size, file md5)
        // — without these we can't tell apart a malformed-payload
        // reject, a session-ticket mismatch, or a per-account rate-
        // limit.
        const segRetCode = resp.msgSegHead?.retCode ?? 0;
        const fileMd5Hex = Buffer.from(fileMd5).toString('hex');
        throw new Error(
          `highway upload error_code=${resp.errorCode}` +
          ` (cmdId=${commandId} chunk=${chunkSize}/${bytes.length}` +
          ` offset=${offset} segRetCode=${segRetCode}` +
          ` fileMd5=${fileMd5Hex.slice(0, 16)}…)`,
        );
      }
      offset += chunkSize;
      console.log(`[Highway] uploaded ${offset}/${bytes.length} bytes`);
    }
  } finally {
    socket.destroy();
  }
}
