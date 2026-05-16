// Group album actions via TRPC protocol

import type { Bridge } from '../bridge';
import { protoEncode, protoDecode } from '@/protobuf/decode';
import { GetMediaListRequestSchema, GetMediaListResponseSchema } from '../proto/oidb-action';

export interface GroupAlbumMediaResult {
  mediaList: any[];
  nextAttachInfo: string;
}

function convertBigIntToString(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(convertBigIntToString);
  if (typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      result[key] = convertBigIntToString(obj[key]);
    }
    return result;
  }
  return obj;
}

export async function getGroupAlbumMediaList(
    bridge: Bridge,
    groupId: number,
    albumId: string,
    attachInfo: string = ''
): Promise<GroupAlbumMediaResult> {
  const traceId = `_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  const body = protoEncode({
    field1: 0,
    field2: new Uint8Array(0),
    field3: new Uint8Array(0),
    reqInfo: {
      groupId: groupId.toString(),
      albumId: albumId,
      field3: 0,
      attachInfo: attachInfo,
      field5: '',
    },
    traceId: traceId,
    extMap: [{ key: 'fc-appid', value: '100' }],
  }, GetMediaListRequestSchema);

  const result = await bridge.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList',
      body,
      15000
  );

  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'failed to get album media list');
  }

  const resp = protoDecode(result.responseData, GetMediaListResponseSchema);

  if (!resp || (resp as any).field1 !== 0) {
    throw new Error(`fetch album media list error: retCode ${(resp as any)?.field1 || 'unknown'}`);
  }

  const data = (resp as any).data || {};
  const mediaList = data.mediaList || [];
  const nextAttachInfo = data.nextAttachInfo || '';

  return convertBigIntToString({
    mediaList,
    nextAttachInfo,
  });
}
