import type { JsonObject } from './json';

export interface MessageSegment<
  TType extends string = string,
  TData extends Record<string, unknown> = JsonObject,
> {
  type: TType;
  data: TData;
}

export type TextSegment = MessageSegment<'text', { text: string }>;
export type FaceSegment = MessageSegment<'face', { id: string; large?: boolean }>;
export type AtSegment = MessageSegment<'at', { qq: string; name?: string; uid?: string }>;
export type ReplySegment = MessageSegment<'reply', { id: string }>;
export type ImageSegment = MessageSegment<'image', {
  file: string;
  type?: 'flash';
  subType?: number;
  summary?: string;
  url?: string;
}>;
export type RecordSegment = MessageSegment<'record', { file: string; url?: string }>;
export type VideoSegment = MessageSegment<'video', { file: string; url?: string; thumb?: string }>;
export type JsonSegment = MessageSegment<'json', { data: string }>;
export type XmlSegment = MessageSegment<'xml', { data: string; id?: string }>;
export type PokeSegment = MessageSegment<'poke', { type: string | number; id?: string | number }>;
export type ForwardSegment = MessageSegment<'forward', { id: string; res_id?: string; forward_id?: string }>;
export type NodeSegment = MessageSegment<'node', {
  user_id: number;
  nickname: string;
  content: OutgoingMessage;
}>;
export type ShareSegment = MessageSegment<'share', {
  url: string;
  title: string;
  content?: string;
  image?: string;
}>;
export type MusicSegment = MessageSegment<'music', {
  type: string;
  id?: string;
  url?: string;
  audio?: string;
  title?: string;
  image?: string;
  content?: string;
}>;
export type LocationSegment = MessageSegment<'location', {
  lat: string | number;
  lon: string | number;
  title?: string;
  content?: string;
}>;
export type ContactSegment = MessageSegment<'contact', {
  type: 'qq' | 'group' | string;
  id: string | number;
}>;

export type KnownMessageSegment =
  | TextSegment
  | FaceSegment
  | AtSegment
  | ReplySegment
  | ImageSegment
  | RecordSegment
  | VideoSegment
  | JsonSegment
  | XmlSegment
  | PokeSegment
  | ForwardSegment
  | NodeSegment
  | ShareSegment
  | MusicSegment
  | LocationSegment
  | ContactSegment;

export type AnyMessageSegment = KnownMessageSegment | MessageSegment;

export interface MessageChainLike {
  readonly length: number;
  toSegments(): AnyMessageSegment[];
  toJSON(): AnyMessageSegment[];
}

export type OutgoingMessage = string | MessageChainLike | AnyMessageSegment | AnyMessageSegment[];
