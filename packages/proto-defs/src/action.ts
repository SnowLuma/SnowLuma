import type { pb, pb_repeated, int_32, uint_32, uint_64, bytes } from '@snowluma/proton';
import type { Elem } from './element';

// Routing 
export interface RoutingC2C {
  uin?: pb<1, uint_32>;
  uid?: pb<2, string>;
}

export interface RoutingGroup {
  groupCode?: pb<1, uint_64>;
}

// Temp-session (临时会话) routing — used when the target is not a friend.
export interface RoutingGrpTmp {
  groupUin?: pb<1, uint_64>;
  toUin?:    pb<2, uint_64>;
}

// 服务器限制 C2C 文件消息必须使用 Trans0x211 路由头（RoutingHead 字段 15）
// 若误用常规 RoutingC2C 会被服务器拒绝。
// 仅在包含 FileEntity 时触发，且 CcCmd 固定为 4。

export interface RoutingTrans0x211 {
  toUin?: pb<1, uint_64>;
  ccCmd?: pb<2, uint_32>;
  uid?:   pb<8, string>;
}

export interface RoutingHead {
  c2c?:        pb<1, RoutingC2C>;
  grp?:        pb<2, RoutingGroup>;
  grpTmp?:     pb<3, RoutingGrpTmp>;
  trans0x211?: pb<15, RoutingTrans0x211>;
}

// Content Head for send
export interface SendContentHead {
  type?:    pb<1, uint_32>;
  subType?: pb<2, uint_32>;
  c2cCmd?:  pb<3, uint_32>;
}

// Message Control
export interface MessageControl {
  msgFlag?: pb<1, int_32>;
}

// RichText (for send — only elems) 
export interface SendRichText {
  elems?: pb_repeated<2, Elem>;
}

// MessageBody (for send) 
export interface SendMessageBody {
  richText?:   pb<1, SendRichText>;
  // C2C 离线文件元数据（NotOnlineFile）必须序列化后塞入此字段
  // 服务器不会读取 richText.notOnlineFile。
  msgContent?: pb<2, bytes>;
}

// SendMessageRequest
export interface SendMessageRequest {
  routingHead?:    pb<1, RoutingHead>;
  contentHead?:    pb<2, SendContentHead>;
  messageBody?:    pb<3, SendMessageBody>;
  clientSequence?: pb<4, uint_32>;
  random?:         pb<5, uint_32>;
  syncCookie?:     pb<6, bytes>;
  via?:            pb<8, uint_32>;
  dataStatist?:    pb<9, uint_32>;
  ctrl?:           pb<12, MessageControl>;
  multiSendSeq?:   pb<14, uint_32>;
}

// SendMessageResponse
export interface SendMessageResponse {
  result?:          pb<1, int_32>;
  errMsg?:          pb<2, string>;
  timestamp1?:      pb<3, uint_32>;
  field10?:         pb<10, uint_32>;
  groupSequence?:   pb<11, uint_32>;
  timestamp2?:      pb<12, uint_32>;
  privateSequence?: pb<14, uint_32>;
}

// MentionExtra (for building @mention text element)
export interface MentionExtraSend {
  type?:   pb<3, int_32>;
  uin?:    pb<4, uint_32>;
  field5?: pb<5, int_32>;
  uid?:    pb<9, string>;
}

// MarkdownData
export interface MarkdownData {
  content?: pb<1, string>;
}
