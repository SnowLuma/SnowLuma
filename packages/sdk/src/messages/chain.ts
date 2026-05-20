import { segments } from './segments';
import { segmentsToCQString } from './cq-format';
import type {
  AnyMessageSegment,
  ContactSegment,
  ImageSegment,
  JsonObject,
  LocationSegment,
  MessageChainLike,
  MusicSegment,
  OutgoingMessage,
  RecordSegment,
  RequestOptions,
  ShareSegment,
  VideoSegment,
  XmlSegment,
} from '../types/index';

export interface MessageChainSender {
  sendGroupMessage(groupId: number, message: OutgoingMessage, options?: RequestOptions & { autoEscape?: boolean }): Promise<unknown>;
  sendPrivateMessage(userId: number, message: OutgoingMessage, options?: RequestOptions & { autoEscape?: boolean }): Promise<unknown>;
}

const SINGLE_USE_TYPES = new Set(['reply']);

/**
 * Immutable fluent builder for OneBot message segments.
 *
 * The generic state tracks single-use segments such as reply(), so TypeScript
 * can reject duplicate reply segments in normal chained calls.
 */
export class MessageChain<THasReply extends boolean = false> implements MessageChainLike {
  private readonly replyStateBrand?: THasReply;

  private constructor(
    private readonly items: AnyMessageSegment[] = [],
    private readonly used: ReadonlySet<string> = new Set(),
  ) {}

  static empty(): MessageChain<false> {
    return new MessageChain<false>();
  }

  /** Number of segments currently in the chain. */
  get length(): number {
    return this.items.length;
  }

  /** True when no segment has been appended. */
  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  /** Appends a text segment. */
  text(text = ''): MessageChain<THasReply> {
    return this.addSegment(segments.text(text));
  }

  /** Appends a newline text segment. */
  br(): MessageChain<THasReply> {
    return this.text('\n');
  }

  face(id: number | string): MessageChain<THasReply> {
    return this.addSegment(segments.face(id));
  }

  /** Mentions a user or everyone in a group. */
  at(qq: number | 'all', options: { name?: string; uid?: string } = {}): MessageChain<THasReply> {
    return this.addSegment(segments.at(qq, options));
  }

  atAll(): MessageChain<THasReply> {
    return this.at('all');
  }

  /** Adds a reply segment. A chain can contain at most one reply segment. */
  reply(this: MessageChain<false>, id: number | string): MessageChain<true> {
    return this.addSegment(segments.reply(id), 'reply') as MessageChain<true>;
  }

  /** Appends an image segment from a URL, local path, file id, or base64 URI. */
  image(file: string, options: Omit<ImageSegment['data'], 'file'> = {}): MessageChain<THasReply> {
    return this.addSegment(segments.image(file, options));
  }

  record(file: string, options: Omit<RecordSegment['data'], 'file'> = {}): MessageChain<THasReply> {
    return this.addSegment(segments.record(file, options));
  }

  video(file: string, options: Omit<VideoSegment['data'], 'file'> = {}): MessageChain<THasReply> {
    return this.addSegment(segments.video(file, options));
  }

  json(data: string | JsonObject): MessageChain<THasReply> {
    return this.addSegment(segments.json(data));
  }

  xml(data: string, options: Omit<XmlSegment['data'], 'data'> = {}): MessageChain<THasReply> {
    return this.addSegment(segments.xml(data, options));
  }

  poke(type: number | string, id?: number | string): MessageChain<THasReply> {
    return this.addSegment(segments.poke(type, id));
  }

  forward(id: string): MessageChain<THasReply> {
    return this.addSegment(segments.forward(id));
  }

  node(userId: number, nickname: string, content: OutgoingMessage): MessageChain<THasReply> {
    return this.addSegment(segments.node(userId, nickname, content));
  }

  share(options: ShareSegment['data']): MessageChain<THasReply> {
    return this.addSegment(segments.share(options));
  }

  music(options: MusicSegment['data']): MessageChain<THasReply> {
    return this.addSegment(segments.music(options));
  }

  location(options: LocationSegment['data']): MessageChain<THasReply> {
    return this.addSegment(segments.location(options));
  }

  contact(type: ContactSegment['data']['type'], id: number | string): MessageChain<THasReply> {
    return this.addSegment(segments.contact(type, id));
  }

  raw<TType extends string, TData extends JsonObject>(type: TType, data: TData): MessageChain<THasReply> {
    return this.addSegment(segments.raw(type, data), type);
  }

  /** Appends another outgoing message while preserving single-use segment checks. */
  append(messageInput: OutgoingMessage): MessageChain<THasReply> {
    let next: MessageChain<THasReply> = this;
    const normalized = normalizeMessage(messageInput);
    if (typeof normalized === 'string') {
      return next.text(normalized);
    }
    for (const segment of normalized) {
      next = next.addFromSegment(segment);
    }
    return next;
  }

  /** Returns a fresh segment array suitable for OneBot array message format. */
  build(): AnyMessageSegment[] {
    return this.toSegments();
  }

  toArray(): AnyMessageSegment[] {
    return this.toSegments();
  }

  toSegments(): AnyMessageSegment[] {
    return [...this.items];
  }

  toJSON(): AnyMessageSegment[] {
    return this.toSegments();
  }

  toString(): string {
    return segmentsToCQString(this.items);
  }

  /** Sends this chain to a group through a compatible SnowLuma client. */
  sendToGroup(
    client: MessageChainSender,
    groupId: number,
    options?: RequestOptions & { autoEscape?: boolean },
  ): Promise<unknown> {
    return client.sendGroupMessage(groupId, this, options);
  }

  /** Sends this chain to a private chat through a compatible SnowLuma client. */
  sendToPrivate(
    client: MessageChainSender,
    userId: number,
    options?: RequestOptions & { autoEscape?: boolean },
  ): Promise<unknown> {
    return client.sendPrivateMessage(userId, this, options);
  }

  [Symbol.iterator](): IterableIterator<AnyMessageSegment> {
    return this.items[Symbol.iterator]();
  }

  private addFromSegment(segment: AnyMessageSegment): MessageChain<THasReply> {
    return this.addSegment(segment, segment.type);
  }

  private addSegment<TNextReply extends boolean = THasReply>(
    segment: AnyMessageSegment,
    singleUseType?: string,
  ): MessageChain<TNextReply> {
    if (singleUseType && SINGLE_USE_TYPES.has(singleUseType) && this.used.has(singleUseType)) {
      throw new Error(`Message segment "${singleUseType}" can only appear once in a chain`);
    }

    const nextUsed = new Set(this.used);
    if (singleUseType && SINGLE_USE_TYPES.has(singleUseType)) {
      nextUsed.add(singleUseType);
    }
    return new MessageChain<TNextReply>([...this.items, segment], nextUsed);
  }
}

export function chain(): MessageChain<false> {
  return MessageChain.empty();
}

/** Starts a message chain with a text segment. */
export function text(value = ''): MessageChain<false> {
  return chain().text(value);
}

export function br(): MessageChain<false> {
  return chain().br();
}

export function face(id: number | string): MessageChain<false> {
  return chain().face(id);
}

export function at(qq: number | 'all', options: { name?: string; uid?: string } = {}): MessageChain<false> {
  return chain().at(qq, options);
}

export function atAll(): MessageChain<false> {
  return chain().atAll();
}

export function reply(id: number | string): MessageChain<true> {
  return chain().reply(id);
}

/** Starts a message chain with an image segment. */
export function image(file: string, options: Omit<ImageSegment['data'], 'file'> = {}): MessageChain<false> {
  return chain().image(file, options);
}

export function record(file: string, options: Omit<RecordSegment['data'], 'file'> = {}): MessageChain<false> {
  return chain().record(file, options);
}

export function video(file: string, options: Omit<VideoSegment['data'], 'file'> = {}): MessageChain<false> {
  return chain().video(file, options);
}

export function json(data: string | JsonObject): MessageChain<false> {
  return chain().json(data);
}

export function xml(data: string, options: Omit<XmlSegment['data'], 'data'> = {}): MessageChain<false> {
  return chain().xml(data, options);
}

export function poke(type: number | string, id?: number | string): MessageChain<false> {
  return chain().poke(type, id);
}

export function forward(id: string): MessageChain<false> {
  return chain().forward(id);
}

export function node(userId: number, nickname: string, content: OutgoingMessage): MessageChain<false> {
  return chain().node(userId, nickname, content);
}

export function share(options: ShareSegment['data']): MessageChain<false> {
  return chain().share(options);
}

export function music(options: MusicSegment['data']): MessageChain<false> {
  return chain().music(options);
}

export function location(options: LocationSegment['data']): MessageChain<false> {
  return chain().location(options);
}

export function contact(type: ContactSegment['data']['type'], id: number | string): MessageChain<false> {
  return chain().contact(type, id);
}

export function raw<TType extends string, TData extends JsonObject>(type: TType, data: TData): MessageChain<false> {
  return chain().raw(type, data);
}

/** Normalizes a string, segment, segment array, or MessageChain into OneBot output. */
export function normalizeMessage(input: OutgoingMessage): string | AnyMessageSegment[] {
  if (typeof input === 'string') return input;
  if (isMessageChainLike(input)) return input.toSegments();
  return Array.isArray(input) ? input : [input];
}

function isMessageChainLike(value: unknown): value is MessageChainLike {
  return typeof value === 'object'
    && value !== null
    && 'toSegments' in value
    && typeof value.toSegments === 'function';
}
