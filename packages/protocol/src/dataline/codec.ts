import { toHex } from '@snowluma/common/hex';
import type {
  DatalineMsgBody,
  DatalineTextMsg,
} from '@snowluma/proto-defs/dataline';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { MessageElement } from '../events';
import { appIdForTerType, DATALINE_SELF_TER_TYPE } from './device-contacts';

const DATALINE_SUBCMD_FTN = 1;
const DATALINE_SUBCMD_GENERIC = 4;
const DATALINE_GENERIC_TEXT = 1;
const DATALINE_TEXT_ITEM = 1;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeDatalineText(params: {
  selfUin: number;
  srcTerType?: number;
  dstTerType: number;
  text: string;
}): Uint8Array {
  const srcTerType = params.srcTerType ?? DATALINE_SELF_TER_TYPE;
  const textBytes = textEncoder.encode(params.text);
  const buf = protobuf_encode<DatalineTextMsg>({
    items: [{ type: DATALINE_TEXT_ITEM, text: textBytes }],
  });
  const selfUin = BigInt(params.selfUin);
  return protobuf_encode<DatalineMsgBody>({
    subCmd: DATALINE_SUBCMD_GENERIC,
    header: {
      srcAppId: appIdForTerType(srcTerType),
      srcInstId: 1,
      dstAppId: appIdForTerType(params.dstTerType),
      dstInstId: 1,
      dstUin: selfUin,
      srcUin: selfUin,
      srcTerType,
      dstTerType: params.dstTerType,
    },
    generic: {
      sessionId: BigInt(Date.now()),
      size: 1,
      index: 0,
      type: DATALINE_GENERIC_TEXT,
      buf,
    },
  });
}

export function decodeDatalineMsgBody(bytes: Uint8Array): DatalineMsgBody | undefined {
  return protobuf_decode<DatalineMsgBody>(bytes);
}

export function elementsFromDatalineBody(body: DatalineMsgBody): MessageElement[] {
  const elements: MessageElement[] = [];
  if (body.subCmd === DATALINE_SUBCMD_GENERIC || body.generic) {
    const genericType = body.generic?.type ?? 0;
    if (genericType === 0 || genericType === DATALINE_GENERIC_TEXT) {
      const text = decodeGenericText(body.generic?.buf);
      if (text.length > 0) elements.push({ type: 'text', text });
    }
  }
  if (body.subCmd === DATALINE_SUBCMD_FTN || (body.ftn && body.ftn.length > 0)) {
    for (const notify of body.ftn ?? []) {
      const fileName = notify.fileName?.trim();
      if (!fileName && notify.fileIndex == null && notify.sessionId == null) continue;
      const fileSize = notify.fileLen != null ? Number(notify.fileLen) : undefined;
      elements.push({
        type: 'file',
        fileId: notify.fileIndex || (notify.sessionId != null ? String(notify.sessionId) : undefined),
        fileName: fileName || undefined,
        fileSize: fileSize != null && Number.isFinite(fileSize) ? fileSize : undefined,
        md5Hex: notify.fileMd5 && notify.fileMd5.length > 0 ? toHex(notify.fileMd5) : undefined,
      });
    }
  }
  return elements;
}

function decodeGenericText(buf: Uint8Array | undefined): string {
  if (!buf || buf.length === 0) return '';
  const parsed = protobuf_decode<DatalineTextMsg>(buf);
  const parts: string[] = [];
  for (const item of parsed?.items ?? []) {
    if (!item.text || item.text.length === 0) continue;
    parts.push(textDecoder.decode(item.text));
  }
  return parts.join('');
}

export function datalineTextFromElements(elements: readonly MessageElement[]): string {
  if (elements.length === 0) throw new Error('message is empty');
  const unsupported = elements.find((element) => element.type !== 'text');
  if (unsupported) {
    throw new Error(`this contact only accepts text messages, got ${unsupported.type}`);
  }
  const text = elements
    .filter((element): element is Extract<MessageElement, { type: 'text' }> => element.type === 'text')
    .map((element) => element.text)
    .join('');
  if (text.length === 0) throw new Error('message is empty');
  return text;
}
