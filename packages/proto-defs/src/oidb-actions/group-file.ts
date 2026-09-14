import type { pb, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';

export interface OidbGroupFileListReq {
  groupUin?:        pb<1, uint_32>;
  appId?:           pb<2, uint_32>;
  targetDirectory?: pb<3, string>;
  fileCount?:       pb<5, uint_32>;
  sortBy?:          pb<9, uint_32>;
  startIndex?:      pb<13, uint_32>;
  field17?:         pb<17, uint_32>;
  field18?:         pb<18, uint_32>;
}
export interface OidbGroupFileViewReq {
  list?: pb<2, OidbGroupFileListReq>;
}
export interface OidbGroupFileListFolderResp {
  folderId?:          pb<1, string>;
  parentDirectoryId?: pb<2, string>;
  folderName?:        pb<3, string>;
  createTime?:        pb<4, uint_32>;
  modifiedTime?:      pb<5, uint_32>;
  creatorUin?:        pb<6, uint_32>;
  creatorName?:       pb<7, string>;
  totalFileCount?:    pb<8, uint_32>;
  modifierUin?:       pb<9, uint_64>;
  modifierName?:      pb<10, string>;
}
export interface OidbGroupFileListFileResp {
  fileId?:          pb<1, string>;
  fileName?:        pb<2, string>;
  fileSize?:        pb<3, uint_64>;
  busId?:           pb<4, uint_32>;
  uploadedTime?:    pb<6, uint_32>;
  expireTime?:      pb<7, uint_32>;
  modifiedTime?:    pb<8, uint_32>;
  downloadedTimes?: pb<9, uint_32>;
  uploaderName?:    pb<14, string>;
  uploaderUin?:     pb<15, uint_32>;
  parentDirectory?: pb<16, string>;
}
export interface OidbGroupFileListItemResp {
  type?:       pb<1, uint_32>;
  folderInfo?: pb<2, OidbGroupFileListFolderResp>;
  fileInfo?:   pb<3, OidbGroupFileListFileResp>;
}
export interface OidbGroupFileListResp {
  retCode?:       pb<1, uint_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
  isEnd?:         pb<4, bool>;
  items?:         pb_repeated<5, OidbGroupFileListItemResp>;
}
export interface OidbGroupFileViewResp {
  list?: pb<2, OidbGroupFileListResp>;
}
export interface OidbGroupFileUploadReq {
  groupUin?:        pb<1, uint_32>;
  appId?:           pb<2, uint_32>;
  busId?:           pb<3, uint_32>;
  entrance?:        pb<4, uint_32>;
  targetDirectory?: pb<5, string>;
  fileName?:        pb<6, string>;
  localDirectory?:  pb<7, string>;
  fileSize?:        pb<8, uint_64>;
  fileSha1?:        pb<9, bytes>;
  fileSha3?:        pb<10, bytes>;
  fileMd5?:         pb<11, bytes>;
  field15?:         pb<15, bool>;
}
export interface OidbGroupFileDownloadReq {
  groupUin?: pb<1, uint_32>;
  appId?:    pb<2, uint_32>;
  busId?:    pb<3, uint_32>;
  fileId?:   pb<4, string>;
}
export interface OidbGroupFileDeleteReq {
  groupUin?: pb<1, uint_32>;
  busId?:    pb<3, uint_32>;
  fileId?:   pb<5, string>;
}
export interface OidbGroupFileMoveReq {
  groupUin?:        pb<1, uint_32>;
  appId?:           pb<2, uint_32>;
  busId?:           pb<3, uint_32>;
  fileId?:          pb<4, string>;
  parentDirectory?: pb<5, string>;
  targetDirectory?: pb<6, string>;
}
export interface OidbGroupFileRenameReq {
  groupUin?:     pb<1, uint_32>;
  busId?:        pb<3, uint_32>;
  fileId?:       pb<4, string>;
  parentFolder?: pb<5, string>;
  newFileName?:  pb<6, string>;
}
export interface OidbGroupFileReq {
  file?:     pb<1, OidbGroupFileUploadReq>;
  download?: pb<3, OidbGroupFileDownloadReq>;
  delete?:   pb<4, OidbGroupFileDeleteReq>;
  rename?:   pb<5, OidbGroupFileRenameReq>;
  move?:     pb<6, OidbGroupFileMoveReq>;
}
export interface OidbGroupFileUploadResp {
  retCode?:       pb<1, int_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
  uploadIp?:      pb<4, string>;
  serverDns?:     pb<5, string>;
  busId?:         pb<6, int_32>;
  fileId?:        pb<7, string>;
  checkKey?:      pb<8, bytes>;
  fileKey?:       pb<9, bytes>;
  boolFileExist?: pb<10, bool>;
  uploadPort?:    pb<14, uint_32>;
}
export interface OidbGroupFileDownloadResp {
  retCode?:       pb<1, uint_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
  downloadIp?:    pb<4, string>;
  downloadDns?:   pb<5, string>;
  downloadUrl?:   pb<6, bytes>;
  saveFileName?:  pb<11, string>;
}
export interface OidbGroupFileRetResp {
  retCode?:       pb<1, uint_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
}
export interface OidbGroupFileResp {
  upload?:   pb<1, OidbGroupFileUploadResp>;
  download?: pb<3, OidbGroupFileDownloadResp>;
  delete?:   pb<4, OidbGroupFileRetResp>;
  rename?:   pb<5, OidbGroupFileRetResp>;
  move?:     pb<6, OidbGroupFileRetResp>;
}
export interface OidbGroupTransFileReq {
  groupUin?: pb<1, uint_64>;
  appId?:    pb<2, uint_32>;
  busId?:    pb<3, uint_32>;
  fileId?:   pb<4, string>;
}
export interface OidbGroupTransFileResp {
  retCode?:       pb<1, int_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
  saveBusId?:     pb<4, uint_32>;
  saveFilePath?:  pb<5, string>;
}
export interface OidbGroupSendFileInfo {
  busiType?: pb<1, uint_32>;
  fileId?:   pb<2, string>;
  field3?:   pb<3, uint_32>;
  field4?:   pb<4, string>;
  field5?:   pb<5, bool>;
}
export interface OidbGroupSendFileBody {
  groupUin?: pb<1, uint_32>;
  type?:     pb<2, uint_32>;
  info?:     pb<3, OidbGroupSendFileInfo>;
}
export interface OidbGroupSendFileReq {
  transFile?: pb<1, OidbGroupTransFileReq>;
  body?: pb<5, OidbGroupSendFileBody>;
}
export interface OidbGroupSendFileResp {
  transFile?: pb<1, OidbGroupTransFileResp>;
}
export interface OidbGroupFileCreateFolderReq {
  groupUin?:      pb<1, uint_32>;
  rootDirectory?: pb<3, string>;
  folderName?:    pb<4, string>;
}
export interface OidbGroupFileDeleteFolderReq {
  groupUin?: pb<1, uint_32>;
  folderId?: pb<3, string>;
}
export interface OidbGroupFileRenameFolderReq {
  groupUin?:      pb<1, uint_32>;
  folderId?:      pb<3, string>;
  newFolderName?: pb<4, string>;
}
export interface OidbGroupFileFolderReq {
  create?: pb<1, OidbGroupFileCreateFolderReq>;
  delete?: pb<2, OidbGroupFileDeleteFolderReq>;
  rename?: pb<3, OidbGroupFileRenameFolderReq>;
}
// The create (0x6D7_0) response also carries the new folder's info at field 4
// — the source of folderId (#195). delete/rename responses leave it empty.
// Tags confirmed against a live create response (bot creating a folder in a
// test group): modifyUin is field 9, NOT 7 as Lagrange's
// OidbSvcTrpcTcp0x6D7_0ResponseFolderInfo has it.
export interface OidbGroupFileFolderInfoResp {
  folderId?:   pb<1, string>;
  folderPath?: pb<2, string>;
  folderName?: pb<3, string>;
  createTime?: pb<4, uint_32>;
  modifyTime?: pb<5, uint_32>;
  createUin?:  pb<6, uint_32>;
  modifyUin?:  pb<9, uint_32>;
}
export interface OidbGroupFileFolderRetResp {
  retcode?:       pb<1, uint_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
  folderInfo?:    pb<4, OidbGroupFileFolderInfoResp>;
}
export interface OidbGroupFileFolderResp {
  create?: pb<1, OidbGroupFileFolderRetResp>;
  delete?: pb<2, OidbGroupFileFolderRetResp>;
  rename?: pb<3, OidbGroupFileFolderRetResp>;
}
export interface OidbGroupFileCountReq {
  groupUin?: pb<1, uint_32>;
  appId?:    pb<2, uint_32>;
  busId?:    pb<3, uint_32>;
}
// Count response (0x6D8_2): fileCount is field 4 and maxCount (the group's file
// ceiling, e.g. 1500) field 6 — RE'd from a live count query (#196). The old
// pb<1>/pb<2> tags matched nothing, so file_count always decoded to 0.
export interface OidbGroupFileCountResp {
  fileCount?: pb<4, uint_32>;
  maxCount?:  pb<6, uint_32>;
  isFull?:    pb<7, bool>;
}
// Space request/response (0x6D8_3). Both values are 64-bit — the 10 GiB ceiling
// already exceeds uint32.
export interface OidbGroupFileSpaceReq {
  groupUin?: pb<1, uint_32>;
  appId?:    pb<2, uint_32>;
}
export interface OidbGroupFileSpaceResp {
  totalSpace?: pb<4, uint_64>;
  usedSpace?:  pb<5, uint_64>;
}
// count → subCommand 2, space → subCommand 3 (List is subCommand 1).
export interface OidbGroupFileCountViewReq {
  count?: pb<3, OidbGroupFileCountReq>;
  space?: pb<4, OidbGroupFileSpaceReq>;
}
export interface OidbGroupFileCountViewResp {
  count?: pb<3, OidbGroupFileCountResp>;
  space?: pb<4, OidbGroupFileSpaceResp>;
}
