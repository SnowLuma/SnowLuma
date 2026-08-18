import type { JsonObject, JsonValue } from './json';

export interface OneBotBaseEvent extends JsonObject {
  time: number;
  self_id: number;
  post_type: string;
}

export interface OneBotSender extends JsonObject {
  user_id: number;
  nickname: string;
  sex?: string;
  age?: number;
  card?: string;
  role?: string;
}

export interface OneBotPrivateMessageEvent extends OneBotBaseEvent {
  post_type: 'message' | 'message_sent';
  message_type: 'private';
  sub_type: string;
  message_id: number;
  message_seq?: number;
  user_id: number;
  message: JsonValue;
  raw_message: string;
  font: number;
  sender: OneBotSender;
}

export interface OneBotGroupMessageEvent extends OneBotBaseEvent {
  post_type: 'message' | 'message_sent';
  message_type: 'group';
  sub_type: string;
  message_id: number;
  message_seq?: number;
  group_id: number;
  user_id: number;
  message: JsonValue;
  raw_message: string;
  font: number;
  sender: OneBotSender;
  anonymous?: JsonValue;
}

export type OneBotMessageEvent = OneBotPrivateMessageEvent | OneBotGroupMessageEvent;

export interface OneBotNoticeEvent extends OneBotBaseEvent {
  post_type: 'notice';
  notice_type: string;
}

export interface OneBotRequestEvent extends OneBotBaseEvent {
  post_type: 'request';
  request_type: string;
  flag: string;
  sub_type?: string;
  group_id?: number;
  user_id?: number;
  /** Invitee QQ number on `request.group` / `invite`. */
  invited_id?: number;
  comment?: string;
}

export interface OneBotMetaEvent extends OneBotBaseEvent {
  post_type: 'meta_event';
  meta_event_type: string;
}

export type SnowLumaEvent =
  | OneBotMessageEvent
  | OneBotNoticeEvent
  | OneBotRequestEvent
  | OneBotMetaEvent
  | OneBotBaseEvent;
