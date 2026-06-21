// OIDB 0x93cf-0x9427, 0x12a9 — QQ 闪传（FlashTransfer / fileset）协议类型。
// 响应成功靠 OIDB envelope 的 errorCode(f3=0)，业务体无 retCode。

import type { pb, pb_optional, pb_repeated, uint_32, uint_64, bytes } from '@snowluma/proton';

// ─────────────── 共用：文件条目（0x93d2/0x93d3 响应里的每个文件/fileset） ───────────────

/** f9.f2 — 下载信息（f1=类型，f2=下载URL，URL 里已含 rkey 或 fldc）。 */
export interface FlashFileDownloadInfo {
  field1?: pb<1, uint_32>;
  downloadUrl?: pb<2, string>;
}

/** f9 — fileId + 下载信息。 */
export interface FlashFileIdWrap {
  fileId?: pb<1, string>;
  download?: pb<2, FlashFileDownloadInfo>;
}

/** f8 — 上传/分享 URL（qfile.qq.com/q/<code>）。 */
export interface FlashFileUploadUrl {
  uploadUrl?: pb<1, string>;
}

/** 文件条目。0x93d3 响应 f1（单条）；0x93d2 响应 f1（repeated，多个 fileset）。 */
export interface FlashFileEntry {
  filesetUuid?: pb<1, string>;
  fileName?: pb<2, string>;
  origName?: pb<3, string>;
  fileType?: pb<4, uint_32>;
  fileSize?: pb<5, uint_64>;
  uploadUrlWrap?: pb<8, FlashFileUploadUrl>;
  fileIdWrap?: pb<9, FlashFileIdWrap>;
}

// ─────────────── 0x93d3 — 拉取文件集详情（点分享显示链接时触发） ───────────────

export interface FlashGetDetailReq {
  filesetUuid?: pb<1, string>;
  field2?: pb<2, uint_32>;   // 7
}
export interface FlashGetDetailResp {
  entries?: pb_repeated<1, FlashFileEntry>;
}

// ─────────────── 0x93d2 — 查询 fileset 列表 ───────────────

export interface FlashListFilesetsReq {
  field1?: pb<1, uint_32>;   // 3
  field2?: pb<2, string>;    // ""
  field3?: pb<3, uint_32>;   // 10
}
export interface FlashListFilesetsResp {
  entries?: pb_repeated<1, FlashFileEntry>;
}

// ─────────────── 0x93d4 — 拉取下载URL（完整参数 + fldc） ───────────────

export interface FlashGetDownloadUrlReqInner {
  field1?: pb<1, string>;
  field2?: pb<2, uint_32>;
  field3?: pb<3, uint_32>;
  field4?: pb<4, string>;
  field5?: pb<5, FlashGetDownloadUrlReqInner5>;
  field6?: pb<6, FlashGetDownloadUrlReqInner6>;
}
export interface FlashGetDownloadUrlReqInner5 { field1?: pb<1, uint_32>; }
export interface FlashGetDownloadUrlReqInner6 { field1?: pb<1, uint_32>; field2?: pb<2, uint_32>; }

export interface FlashGetDownloadUrlReq {
  filesetUuid?: pb<1, string>;
  inner?: pb<2, FlashGetDownloadUrlReqInner>;
  field3?: pb<3, uint_32>;   // 7
  field4?: pb<4, uint_32>;   // 1
}
/** 0x93d4 响应 f1.f3.f13.f2 — downloadUrl 包装（结构不同于 0x93d3 的 FlashFileDownloadInfo）。 */
export interface FlashDownloadUrlWrap {
  field1?: pb<1, uint_32>;            // 2
  downloadUrl?: pb<2, string>;
}
/** 0x93d4 响应 f1.f3.f13 — fileId + downloadUrl + sha1/md5/宽高。 */
export interface FlashDownloadUrlInfo {
  fileId?: pb<1, string>;
  download?: pb<2, FlashDownloadUrlWrap>;
  sha1?: pb<3, string>;
  field4?: pb<4, uint_32>;
  md5?: pb<5, string>;
  width?: pb<6, uint_32>;
  height?: pb<7, uint_32>;
}
/** 0x93d4 响应 f1.f3.f14 — 主文件 fileId（无 downloadUrl，下载 URL 需 0x12a9 sub=200）。 */
export interface FlashDownloadMainFile {
  fileId?: pb<1, string>;
  field3?: pb<3, uint_32>;            // 2
}
/** 0x93d4 响应 f1.f3 — 文件信息（字段号不同于 0x93d3 的 FlashFileEntry）。 */
export interface FlashDownloadFileInfo {
  filesetUuid?: pb<1, string>;
  fileUuid?: pb<2, string>;
  field5?: pb<5, uint_32>;
  field6?: pb<6, uint_32>;
  field7?: pb<7, uint_32>;
  fileName?: pb<8, string>;
  origName?: pb<9, string>;
  fileSize?: pb<11, uint_64>;
  downloadInfo?: pb<13, FlashDownloadUrlInfo>;
  mainFile?: pb<14, FlashDownloadMainFile>;
}
/** 0x93d4 响应 f1 — entry wrapper。多文件 fileset 时 f3 含每个文件的 fileInfo。 */
export interface FlashDownloadEntry {
  field2?: pb<2, uint_32>;            // 1
  /** repeated：多文件 fileset 时每个文件一个 fileInfo（f6=文件序号，f14=主文件 fileId）。 */
  fileInfo?: pb_repeated<3, FlashDownloadFileInfo>;
  field4?: pb<4, string>;             // JSON：{"offset":N,"cursor_time":"..."}
  field5?: pb<5, uint_32>;            // 1
}
/** 0x93d4 响应 — downloadUrl 在 f1.f3.f13.f2.f2（深层嵌套，非 0x93d3 的 f9.fileIdWrap）。 */
export interface FlashGetDownloadUrlResp {
  entry?: pb<1, FlashDownloadEntry>;
}

// ─────────────── 0x9407 — 删除闪传文件（额外，OneBot 标准未定义） ───────────────

export interface FlashDeleteFileReq {
  filesetUuid?: pb<1, string>;
  field2?: pb<2, string>;    // ""
  field3?: pb<3, uint_32>;   // 7
}
export interface FlashDeleteFileResp {}

// ─────────────── 0x9427 — 重命名闪传文件（额外，OneBot 标准未定义） ───────────────

export interface FlashRenameFileReqName {
  newName?: pb<1, string>;
  displayName?: pb<2, string>;
}
export interface FlashRenameFileReqFlag {
  field1?: pb<1, uint_32>;
}
export interface FlashRenameFileReq {
  filesetUuid?: pb<1, string>;
  name?: pb<2, FlashRenameFileReqName>;
  flag?: pb<3, FlashRenameFileReqFlag>;
}
export interface FlashRenameFileResp {}

// ─────────────── 0x93cf — 申请创建 fileSet（上传起点） ───────────────

/** 空占位 message（Uploader.f4 / CommitInfo.f4 / f24 为空 message）。 */
export interface FlashEmpty {}

export interface FlashUploader {
  uin?: pb<1, string>;
  nickname?: pb<2, string>;
  uid?: pb<3, string>;
  field4?: pb<4, FlashEmpty>;
}

/** 0x93cf 请求 f2 — 文件信息。 */
export interface FlashUploadFileInfo {
  fileName?: pb<2, string>;
  origName?: pb<3, string>;
  fileType?: pb<4, uint_32>;
  fileSize?: pb<5, uint_64>;
  uploader?: pb<10, FlashUploader>;
  field16?: pb<16, uint_32>;
  field20?: pb<20, uint_32>;
  field21?: pb<21, uint_32>;
}

export interface FlashApplyFilesetReq {
  field1?: pb<1, uint_32>;   // 1
  fileInfo?: pb<2, FlashUploadFileInfo>;
  /** 文件类型码：rar=2, png/mp4=7（按扩展名映射，FlashTransferApi.fileTypeCode）。 */
  typeCode?: pb<3, uint_32>;
  field12?: pb<12, uint_32>;  // 1
}
export interface FlashApplyFilesetResp {
  filesetUuid?: pb<1, string>;
  /** 上传会话 key（与 f1 同值）。 */
  uploadKey?: pb<2, string>;
  /** 上传 URL https://qfile.qq.com/q/<code>。 */
  uploadUrl?: pb<3, string>;
  expire?: pb<4, uint_64>;
  ttl?: pb<5, uint_32>;
}

// ─────────────── 0x93d0 — 单文件上传完成上报（commit） ───────────────

export interface FlashCommitFileInfo {
  filesetUuid?: pb<1, string>;
  fileUuid?: pb<2, string>;
  /** pb_optional 强制 0 值上 wire（服务端多文件严格校验字段存在，省略 0 会导致文件不计入）。 */
  field3?: pb_optional<3, uint_32>;
  field4?: pb<4, FlashEmpty>;
  field5?: pb_optional<5, uint_32>;
  /** 文件序号：fileset 内从 1 递增（1,2,3...），多文件时每条各不相同。
   *  必须与 0x12a9 sub=100/103 filesetWrap.f4 一致，否则服务端不把文件计入 fileset。 */
  field6?: pb_optional<6, uint_32>;
  /** 格式码：rar=4, mp4=2, png=26（按扩展名映射）。 */
  formatCode?: pb_optional<7, uint_32>;
  fileName?: pb<8, string>;
  origName?: pb<9, string>;
  field10?: pb_optional<10, uint_32>;
  fileSize?: pb<11, uint_64>;
  field12?: pb_optional<12, uint_32>;
  field24?: pb<24, FlashEmpty>;
}

export interface FlashCommitFileReq {
  field1?: pb<1, uint_32>;       // 1
  filesetUuid?: pb<2, string>;
  uploadKey?: pb<3, string>;     // 同 filesetUuid
  /** repeated：一个 0x93d0 请求同时携带 fileset 内所有文件条目（多文件机制）。
   *  每条 field6=文件序号（1,2,3...）。单文件时只有一个条目。 */
  commitInfo?: pb_repeated<4, FlashCommitFileInfo>;
  field5?: pb<5, uint_32>;       // 1
  field6?: pb<6, uint_32>;       // 1
}
export interface FlashCommitFileResp {
  field1?: pb<1, uint_32>;
  filesetUuid?: pb<2, string>;
  uploadKey?: pb<3, string>;
}

// ─────────────── 0x93db — fileSet 完成 ───────────────

export interface FlashCompleteFilesetReq {
  filesetUuid?: pb<1, string>;
  field2?: pb<2, string>;    // ""
}
export interface FlashCompleteFilesetResp {}

// ─────────────── 0x93d1 — 设置 fileSet 状态 ───────────────

export interface FlashSetStatusReq {
  filesetUuid?: pb<1, string>;
  status?: pb<2, uint_32>;   // 6
}
export interface FlashSetStatusResp {}

// ─────────────── sliceupload（大文件分片上传） ───────────────

/** sliceupload f107.f6 — 累积 SHA1 state list。每片对应从文件开头到该片末尾的
 *  SHA1 中间 state（不 finalize，小端 20B），最后一片是标准整文件 SHA1。
 *  服务端按此校验分片完整性，传独立分片 SHA1 会被拒（报 "file range data sha1 not match"）。 */
export interface FlashSha1StateV {
  state?: pb_repeated<1, bytes>;
}

/** sliceupload body f107 — 切片 payload。 */
export interface FlashSlicePayload {
  field1?: pb<1, FlashEmpty>;
  rkey?: pb<2, string>;               // 上传凭证（来自 sub=100 响应）
  start?: pb_optional<3, uint_32>;    // 本片字节 offset
  end?: pb_optional<4, uint_32>;      // start + chunkLen - 1
  sha1?: pb<5, bytes>;                // 当前片 SHA1
  sha1StateV?: pb<6, FlashSha1StateV>;
  chunk?: pb<7, bytes>;               // 本片文件字节
}

/** sliceupload HTTP body — POST multimedia.qfile.qq.com/sliceupload。 */
export interface FlashSliceUploadBody {
  field1?: pb_optional<1, uint_32>;   // 0
  appid?: pb<2, uint_32>;             // 14901（与 fileId 的 appid 不同）
  field3?: pb_optional<3, uint_32>;   // 2
  payload?: pb<107, FlashSlicePayload>;
}

/** sliceupload HTTP 响应 — f5=status，"success" 表示该片已落盘。 */
export interface FlashSliceUploadResp {
  status?: pb<5, string>;
}

/** sub=103 wrapper.f2 fileId — 客户端构造的 protobuf，base64url 编码。
 *  appid 用 14902：下载 URL（0x93d4 返回）的 appid 也是 14902，两者必须一致，
 *  否则下载报 "appid is not match"。sliceupload body 的 appid 则用 14901。 */
export interface FlashFileId {
  sha1?: pb<2, bytes>;               // 整文件 SHA1
  fileSize?: pb<3, uint_32>;
  appid?: pb<4, uint_32>;            // 14902
  timestamp?: pb<5, uint_64>;        // 微秒时间戳
  env?: pb<6, string>;               // "prod"
  ttl?: pb<10, uint_32>;             // 1209600（14 天）
  sessionId?: pb<11, bytes>;         // 16B，随机生成
  field15?: pb<15, bytes>;           // 3B
  region?: pb<16, string>;           // "gz"
}

// ─────────────── 0x12a9 sub=100/103 — prepare/apply-upload ───────────────
// sub=100 与 sub=103 的 payload 字段号不同：sub=100 在 f2，sub=103 在 f12。
// sub=100 返回 sliceupload rkey；sub=103 注册 fileId，响应无 rkey。
// 下面的类型描述 sub=103 的 f12 结构（sub=100 的 f2 结构对应 FlashPrepareUploadPayload）。

/** FileInfo.f5 — f4 是 varint，与 FlashApplyPayloadField3.f4 的 message 类型不同。
 *  pb_optional 保证 0 值显式上 wire，服务端要求字段存在。 */
export interface FlashApplyFileInfo5 {
  field1?: pb_optional<1, uint_32>;    // sub=100=1 / sub=103=0
  field2?: pb_optional<2, uint_32>;
  field3?: pb_optional<3, uint_32>;
  field4?: pb_optional<4, uint_32>;
}

/** f12.f3 — f4 是空 message，与 FileInfo5.f4 的 varint 类型不同。 */
export interface FlashApplyPayloadField3 {
  field1?: pb_optional<1, uint_32>;
  field2?: pb_optional<2, uint_32>;
  field3?: pb_optional<3, uint_32>;
  field4?: pb<4, FlashEmpty>;
}

/** f12.f10 — fileset 包装（filesetUuid + fileUuid + flags）。 */
export interface FlashApplyFilesetWrap {
  filesetUuid?: pb_optional<1, string>;
  uploadKey?: pb_optional<2, string>;           // 同 filesetUuid
  fileUuid?: pb_optional<3, string>;
  field4?: pb_optional<4, uint_32>;             // 1
  field5?: pb_optional<5, uint_32>;             // 0
  field6?: pb_optional<6, uint_32>;             // sub=100=0 / sub=103=1
  field7?: pb_optional<7, uint_32>;             // 2
  field8?: pb<8, FlashEmpty>;
  field9?: pb_optional<9, uint_32>;             // 1
  field10?: pb_optional<10, uint_32>;
  field11?: pb_optional<11, uint_32>;
  field12?: pb_optional<12, uint_32>;
  field13?: pb_optional<13, uint_32>;
  field14?: pb_optional<14, uint_32>;
}

/** 0x12a9 f12.f1.f1 — FileInfo。 */
export interface FlashApplyFileInfo {
  fileSize?: pb_optional<1, uint_32>;
  md5?: pb_optional<2, string>;                 // 32 hex（sub=100 空，sub=103 有）
  sha1?: pb_optional<3, string>;                // 40 hex
  fileName?: pb_optional<4, string>;
  field5?: pb<5, FlashApplyFileInfo5>;
  field6?: pb_optional<6, uint_32>;
  field7?: pb_optional<7, uint_32>;
  field8?: pb_optional<8, uint_32>;
  field9?: pb_optional<9, uint_32>;             // sub=100=0 / sub=103=1
}

/** 0x12a9 f12.f1 — wrapper（FileInfo + fileId + 时间戳/TTL）。 */
export interface FlashApplyUploadWrapper {
  fileInfo?: pb<1, FlashApplyFileInfo>;
  fileId?: pb_optional<2, string>;              // sub=100 不带，sub=103 带
  field3?: pb_optional<3, uint_32>;             // 1
  field4?: pb_optional<4, uint_32>;             // 时间戳
  field5?: pb_optional<5, uint_32>;             // TTL 1209600（14 天）
  field6?: pb_optional<6, uint_32>;
}

/** 0x12a9 f12 — apply-upload payload。 */
export interface FlashApplyUploadPayload {
  wrapper?: pb<1, FlashApplyUploadWrapper>;
  flag2?: pb<2, FlashApplyFlag2>;               // {f1:2}
  field3?: pb<3, FlashApplyPayloadField3>;      // {f1:0,f2:0,f3:0,f4:{}}
  filesetWrap?: pb<10, FlashApplyFilesetWrap>;
}
export interface FlashApplyFlag2 { field1?: pb<1, uint_32>; }

/** 0x12a9 请求 f1 — head（seq + sub + config）。 */
export interface FlashApplyHeadSub { seq?: pb<1, uint_32>; sub?: pb<2, uint_32>; }
export interface FlashApplyHeadConfig {
  field101?: pb<101, uint_32>;
  field102?: pb<102, uint_32>;
  field103?: pb<103, uint_32>;         // 文件类型：jpg=24 / png=23 / mp4=22
  field200?: pb<200, uint_32>;
}
export interface FlashApplyHead {
  sub?: pb<1, FlashApplyHeadSub>;
  config?: pb<2, FlashApplyHeadConfig>;
  field3?: pb<3, FlashApplyFlag2>;     // {f1:1}
}

/** 0x12a9 sub=103 请求（payload @ f12）。 */
export interface FlashApplyUploadReq {
  head?: pb<1, FlashApplyHead>;
  payload?: pb<12, FlashApplyUploadPayload>;
}

/** 0x12a9 apply-upload 响应 — rkey 在 f2。 */
export interface FlashApplyUploadResp {
  head?: pb<1, FlashApplyHeadResp>;
  rkeyWrap?: pb<2, FlashRkeyWrap>;
}
export interface FlashApplyHeadResp {
  sub?: pb<1, FlashApplyHeadSub>;
  msg?: pb<3, string>;                 // "success"
}
export interface FlashRkeyWrap { rkey?: pb<1, string>; }

// ─────────────── 0x12a9 sub=100 — prepare-upload ───────────────
// sub=100 的 payload 在 f2（sub=103 在 f12），filesetWrap 在 f9（sub=103 在 f10），
// wrapper.f2 是 varint 0（sub=103 是 fileId string）。
/** sub=100 payload.f6.f1。 */
export interface FlashPreparePayloadF6F1 {
  field1?: pb_optional<1, uint_32>;
  field2?: pb<2, FlashEmpty>;
}
/** sub=100 payload.f6.f2。 */
export interface FlashPreparePayloadF6F2 {
  field3?: pb<3, FlashEmpty>;
}
/** sub=100 payload.f6.f3。 */
export interface FlashPreparePayloadF6F3 {
  field11?: pb<11, FlashEmpty>;
  field12?: pb<12, FlashEmpty>;
}
/** sub=100 payload.f6 — 嵌套 message（固定值）。 */
export interface FlashPreparePayloadF6 {
  field1?: pb<1, FlashPreparePayloadF6F1>;
  field2?: pb<2, FlashPreparePayloadF6F2>;
  field3?: pb<3, FlashPreparePayloadF6F3>;
  field10?: pb_optional<10, uint_32>;
}
/** sub=100 wrapper — f2 是 varint 0（sub=103 是 fileId）。 */
export interface FlashPrepareWrapper {
  fileInfo?: pb<1, FlashApplyFileInfo>;
  field2?: pb_optional<2, uint_32>;
}
/** sub=100 payload。 */
export interface FlashPrepareUploadPayload {
  wrapper?: pb<1, FlashPrepareWrapper>;
  field2?: pb_optional<2, uint_32>;            // 1
  field3?: pb_optional<3, uint_32>;
  field4?: pb_optional<4, uint_32>;
  field5?: pb_optional<5, uint_32>;
  field6?: pb<6, FlashPreparePayloadF6>;
  field7?: pb_optional<7, uint_32>;
  field8?: pb_optional<8, uint_32>;
  filesetWrap?: pb<9, FlashApplyFilesetWrap>;  // f9（sub=103 在 f10）；f6=0（sub=103=1）
}
/** sub=100 请求 — payload 在 f2（sub=103 在 f12）。 */
export interface FlashPrepareUploadReq {
  head?: pb<1, FlashApplyHead>;
  payload?: pb<2, FlashPrepareUploadPayload>;
}
/** sub=100 响应 — f2.f1 是 sliceupload rkey；秒传时 f1 缺失（deserialize 返回 null）。 */
export interface FlashPrepareUploadResp {
  head?: pb<1, FlashApplyHeadResp>;
  rkeyWrap?: pb<2, FlashRkeyWrap>;
}

// ─────────────── 0x93d7 — 发送闪传文件给用户（send_flash_msg） ───────────────
// 请求 f1={f1:1, f2:{f1:targetUid}}, f2=filesetUuid（私聊）；
//      f1={f1:2, f3:{f1:groupId}}, f2=filesetUuid（群聊）。响应仅回显目标（无 message_id）。
/** 0x93d7 请求 f1.f2 — 私聊目标 uid 包装。 */
export interface FlashSendTargetUid {
  targetUid?: pb<1, string>;
}
/** 0x93d7 请求 f1.f3 — 群聊目标 groupId 包装。 */
export interface FlashSendTargetGroupId {
  groupId?: pb<1, uint_32>;
}
/** 0x93d7 请求 f1 — 发送目标。私聊 f1=1+f2(uid)，群聊 f1=2+f3(groupId)。 */
export interface FlashSendTarget {
  field1?: pb<1, uint_32>;
  targetUid?: pb<2, FlashSendTargetUid>;
  targetGroup?: pb<3, FlashSendTargetGroupId>;
}
/** 0x93d7 请求。 */
export interface FlashSendReq {
  target?: pb<1, FlashSendTarget>;
  filesetUuid?: pb<2, string>;
}
/** 0x93d7 响应 f1.f3 — 回显目标。 */
export interface FlashSendRespEcho {
  target?: pb<3, FlashSendTarget>;
}
/** 0x93d7 响应 — 仅回显目标，无 message_id（分享 fileset，非传统消息）。 */
export interface FlashSendResp {
  echo?: pb<1, FlashSendRespEcho>;
}

// ─────────────── 0x12a9 sub=200 — get-download（主文件下载直链）───────────────
// 请求 payload @ f3（不同于 sub=100 的 f2 / sub=103 的 f12）。响应 f3 含 rkey + 主文件下载 URL。
// 主文件下载 URL（appid=14901）的唯一来源；0x93d3/0x93d4 的 downloadUrl 是缩略图。
/** sub=200 请求 f3.f1.f1 — FileInfo（简化，只 fileName）。 */
export interface FlashGetDownloadFileInfo {
  field1?: pb<1, uint_32>;                 // 0
  field4?: pb<4, string>;                  // fileName
  field5?: pb<5, FlashApplyFileInfo5>;     // {0,0,0,0}
  field6?: pb<6, uint_32>;                 // 0
  field7?: pb<7, uint_32>;                 // 0
  field8?: pb<8, uint_32>;                 // 0
  field9?: pb<9, uint_32>;                 // 0
}
/** sub=200 请求 f3.f1 — wrapper（FileInfo + 主文件 fileId）。 */
export interface FlashGetDownloadWrapper {
  fileInfo?: pb<1, FlashGetDownloadFileInfo>;
  fileId?: pb<2, string>;                  // 主文件 fileId（来自 0x93d4 f14.f1）
  field3?: pb<3, uint_32>;                 // 0
  field4?: pb<4, uint_32>;                 // 0
  field5?: pb<5, uint_32>;                 // 0
  field6?: pb<6, uint_32>;                 // 0
}
/** sub=200 请求 f3.f2.f2 — 固定下载参数（真客户端实测值，未观察到随文件变化）。 */
export interface FlashGetDownloadParam {
  field1?: pb<1, uint_32>;                 // 4294967294
  field3?: pb<3, uint_32>;                 // 4294967295
  field5?: pb<5, uint_32>;                 // 111
  field6?: pb<6, FlashGetDownloadParam6>;
}
export interface FlashGetDownloadParam6 {
  field1?: pb<1, uint_32>;                 // 3403722988
}
export interface FlashGetDownloadFlag4 { field1?: pb<1, uint_32>; }
/** sub=200 请求 f3.f2.f10 — filesetWrap（filesetUuid + fileUuid）。 */
export interface FlashGetDownloadFilesetWrap {
  filesetUuid?: pb<1, string>;
  fileUuid?: pb<2, string>;
  field3?: pb<3, uint_32>;                 // 2
  field4?: pb<4, string>;                  // fileUuid
}
/** sub=200 请求 f3.f2。 */
export interface FlashGetDownloadPayload2 {
  field2?: pb<2, FlashGetDownloadParam>;
  field4?: pb<4, FlashGetDownloadFlag4>;
  filesetWrap?: pb<10, FlashGetDownloadFilesetWrap>;
}
/** sub=200 请求 f3 — payload。 */
export interface FlashGetDownloadPayload {
  wrapper?: pb<1, FlashGetDownloadWrapper>;
  field2?: pb<2, FlashGetDownloadPayload2>;
  field3?: pb<3, uint_32>;                 // 0
}
/** sub=200 请求 — payload @ f3。 */
export interface FlashGetDownloadReq {
  head?: pb<1, FlashApplyHead>;            // sub:200
  payload?: pb<3, FlashGetDownloadPayload>;
}
/** sub=200 响应 — f3 含 rkey + 主文件下载 URL（bytes，deserialize 正则提取 URL）。 */
export interface FlashGetDownloadResp {
  head?: pb<1, FlashApplyHeadResp>;
  body?: pb<3, bytes>;
}
