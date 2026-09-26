import type {
  AtSegment,
  ContactSegment,
  FaceSegment,
  ForwardSegment,
  ImageSegment,
  JsonObject,
  JsonSegment,
  LocationSegment,
  MessageSegment,
  MusicSegment,
  NodeSegment,
  OutgoingMessage,
  PokeSegment,
  RecordSegment,
  ReplySegment,
  ShareSegment,
  TextSegment,
  VideoSegment,
  XmlSegment,
} from '../types/index';

function seg<TType extends string, TData extends Record<string, unknown>>(type: TType, data: TData): MessageSegment<TType, TData> {
  return { type, data };
}

export const segments = {
  text(text: string): TextSegment {
    return seg('text', { text });
  },

  face(id: number | string, options: Omit<FaceSegment['data'], 'id'> = {}): FaceSegment {
    return seg('face', { id: String(id), ...options });
  },

  at(qq: number | 'all', options: { name?: string; uid?: string } = {}): AtSegment {
    const data: AtSegment['data'] = { qq: String(qq) };
    if (options.name) data.name = options.name;
    if (options.uid) data.uid = options.uid;
    return seg('at', data);
  },

  reply(id: number | string): ReplySegment {
    return seg('reply', { id: String(id) });
  },

  image(file: string, options: Omit<ImageSegment['data'], 'file'> = {}): ImageSegment {
    return seg('image', { file, ...options });
  },

  record(file: string, options: Omit<RecordSegment['data'], 'file'> = {}): RecordSegment {
    return seg('record', { file, ...options });
  },

  video(file: string, options: Omit<VideoSegment['data'], 'file'> = {}): VideoSegment {
    return seg('video', { file, ...options });
  },

  json(data: string | JsonObject): JsonSegment {
    return seg('json', { data: typeof data === 'string' ? data : JSON.stringify(data) });
  },

  xml(data: string, options: Omit<XmlSegment['data'], 'data'> = {}): XmlSegment {
    return seg('xml', { data, ...options });
  },

  poke(type: number | string, id?: number | string): PokeSegment {
    const data: PokeSegment['data'] = { type };
    if (id !== undefined) data.id = id;
    return seg('poke', data);
  },

  forward(id: string): ForwardSegment {
    return seg('forward', { id, res_id: id, forward_id: id });
  },

  node(userId: number, nickname: string, content: OutgoingMessage): NodeSegment {
    return seg('node', { user_id: userId, nickname, content });
  },

  share(options: ShareSegment['data']): ShareSegment {
    return seg('share', options);
  },

  music(options: MusicSegment['data']): MusicSegment {
    return seg('music', options);
  },

  location(options: LocationSegment['data']): LocationSegment {
    return seg('location', options);
  },

  contact(type: ContactSegment['data']['type'], id: number | string): ContactSegment {
    return seg('contact', { type, id });
  },

  raw<TType extends string, TData extends JsonObject>(type: TType, data: TData): MessageSegment<TType, TData> {
    return seg(type, data);
  },
};
