import type { Bridge } from '../bridge';
import { getGroupAlbumList, uploadImageToGroupAlbum } from '../web/group-album';
import { getCookies } from './cookies';

export async function getGroupAlbumListWeb(bridge: Bridge, groupId: number) {
  const groupCode = groupId.toString();
  const uin = bridge.identity.uin;
  const cookieObject = await getCookies(bridge, 'qzone.qq.com');

  const albumData = await getGroupAlbumList(cookieObject, groupCode, uin);

  return albumData?.album || [];
}

export async function uploadImageToGroupAlbumWeb(
  bridge: Bridge,
  groupId: number,
  albumId: string,
  albumName: string,
  filePath: string
): Promise<void> {
  const groupCode = groupId.toString();
  const uin = bridge.identity.uin;
  const cookieObject = await getCookies(bridge, 'qzone.qq.com');

  await uploadImageToGroupAlbum(cookieObject, groupCode, albumId, albumName, filePath, uin);
}
