// Barrel for the web-action themed split. `bridge.ts` imports
// everything from this directory as if it were a single file; the
// per-theme files keep the implementation discoverable.

export {
  forceFetchClientKey,
  getPSkey,
  getCookies,
  getSKey,
  getBknFromSKey,
  getCookiesStr,
  getCsrfToken,
  getCredentials,
} from './cookies';

export { getGroupHonorInfo } from './group-honor';

export {
  getGroupEssence,
  getGroupEssenceAll,
} from './group-essence';

export {
  sendGroupNotice,
  getGroupNotice,
  deleteGroupNoticeByFid,
} from './group-notice';

export {
  getGroupAlbumListWeb,
  uploadImageToGroupAlbumWeb,
} from './group-album';
