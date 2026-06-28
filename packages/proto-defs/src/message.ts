import type { pb, pb_repeated, int_32, uint_32, uint_64, bytes } from '@snowluma/proton';
import type { Elem } from './element';

// ResponseHead.Grp 
export interface ResponseGrp {
  groupUin?:   pb<1, uint_32>;
  memberName?: pb<2, string>;
  groupName?:  pb<4, string>;
}

export interface ResponseForward {
  friendName?: pb<6, string>;
}

// ResponseHead 
export interface ResponseHead {
  fromUin?: pb<1, uint_32>;
  fromUid?: pb<2, string>;
  type?:    pb<3, uint_32>;
  sigMap?:  pb<4, uint_32>;
  toUin?:   pb<5, uint_32>;
  toUid?:   pb<6, string>;
  forward?: pb<7, ResponseForward>;
  grp?:     pb<8, ResponseGrp>;
}

// ContentHead 
export interface ContentHead {
  msgType?:   pb<1, uint_32>;
  subType?:   pb<2, uint_32>;
  // C2C command / sub-message-type. QQ NT (msg_header_codec_helper.cc::
  // DecodeRoutingHead) reads this as `c2c_cmd` and uses it to route C2C-family
  // pushes (msgType 141/166/167) as system/control signals via OnRecvSysMsg
  // rather than chat bubbles. A fixed set of values is excluded from the chat
  // list — see `isC2cControlPush` in msg-push/blank-filter.ts.
  c2cCmd?:    pb<3, uint_32>;
  msgId?:     pb<4, uint_32>;
  sequence?:  pb<5, uint_32>;
  timestamp?: pb<6, uint_32>;
  field7?:    pb<7, uint_64>;
  newId?:     pb<12, uint_64>;
}

// Ptt (voice) 
export interface Ptt {
  fileType?:     pb<1, uint_32>;
  fileId?:       pb<2, uint_64>;
  fileUuid?:     pb<3, bytes>;
  fileMd5?:      pb<4, bytes>;
  fileName?:     pb<5, string>;
  fileSize?:     pb<6, uint_32>;
  groupFileKey?: pb<10, string>;
  fileKey?:      pb<14, bytes>;
  time?:         pb<19, uint_32>;
  format?:       pb<29, uint_32>;
}

// C2C 离线文件结构
// 1. 发送端必填：字段 9/50/55（subcmd=1, dangerEvel=0, expireTime=当前时间+7天）。
// 2. 接收端只读：核心标识槽位（Uuid/Md5/Name/Size/Hash）。
export interface NotOnlineFile {
  fileType?:   pb<1, uint_32>;
  fileUuid?:   pb<3, string>;
  fileMd5?:    pb<4, bytes>;
  fileName?:   pb<5, string>;
  fileSize?:   pb<6, uint_64>;
  subcmd?:     pb<9, uint_32>;   // 发送必填：固定为 1
  dangerEvel?: pb<50, uint_32>;  // 发送必填：固定为 0
  expireTime?: pb<55, uint_32>;  // 发送必填：过期时间戳（now + 7 days）
  fileHash?:   pb<57, string>;
}

// RichText 
export interface RichText {
  elems?:         pb_repeated<2, Elem>;
  notOnlineFile?: pb<3, NotOnlineFile>;
  ptt?:           pb<4, Ptt>;
}

// MessageBody 
export interface MessageBody {
  richText?:   pb<1, RichText>;
  msgContent?: pb<2, bytes>;
}

// C2C 文件附加信息
// 统一使用与线上数据对齐的 NotOnlineFile 结构，修复收发双向的解析问题。
//
// `field6` 携带服务器签发的下载路由（来自 0xE37_800 finalize 响应的
// metadata）。发送 c2c 文件时缺了它，接收方点开会"文件传输失败"——
// `file` 只是元数据，真正的下载凭证在这里。字段 tag 对照 NapCat
// `message/component.ts: PrivateFileExtra / PrivateFileExtraField2`。
export interface PrivateFileExtraField2 {
  field1?:     pb<1, uint_32>;   // ← finalize metadata.field110
  fileUuid?:   pb<4, string>;
  fileName?:   pb<5, string>;
  field6?:     pb<6, uint_32>;   // ← finalize metadata.field3
  field7?:     pb<7, bytes>;     // ← finalize metadata.field101
  field8?:     pb<8, bytes>;     // ← finalize metadata.field100
  timestamp1?: pb<9, uint_32>;   // ← finalize metadata.timestamp1
  fileHash?:   pb<14, string>;
  selfUid?:    pb<15, string>;
  destUid?:    pb<16, string>;
}
export interface PrivateFileExtra {
  field2?: pb<2, PrivateFileExtraField2>;
}
export interface FileExtra {
  file?:   pb<1, NotOnlineFile>;
  field6?: pb<6, PrivateFileExtra>;
}

// PushMsgBody 
export interface PushMsgBody {
  responseHead?: pb<1, ResponseHead>;
  contentHead?:  pb<2, ContentHead>;
  body?:         pb<3, MessageBody>;
}

// PushMsg (top-level) 
export interface PushMsg {
  message?: pb<1, PushMsgBody>;
  status?:  pb<3, int_32>;
}
