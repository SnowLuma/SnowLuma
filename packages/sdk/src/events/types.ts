import type { SnowLumaApiClient } from '../client/api-client';
import type {
  JsonObject,
  OneBotMessageEvent,
  OutgoingMessage,
  RequestOptions,
  SnowLumaEvent,
} from '../types/index';

export type MaybePromise<T = void> = T | Promise<T>;
export type EventNext = () => Promise<void>;


export type EventPredicate<TEvent extends SnowLumaEvent = SnowLumaEvent> = (event: SnowLumaEvent) => event is TEvent;


export type EventHandler<TEvent extends SnowLumaEvent = SnowLumaEvent> = (
  event: TEvent,
  context: SnowLumaEventContext<TEvent>,
) => MaybePromise;


export type EventMiddleware = (
  event: SnowLumaEvent,
  context: SnowLumaEventContext,
  next: EventNext,
) => MaybePromise;


export interface RequestDecisionOptions extends RequestOptions {
  reason?: string;
  subType?: string;
}


export interface SnowLumaEventContext<TEvent extends SnowLumaEvent = SnowLumaEvent> {
  readonly event: TEvent;
  readonly client: SnowLumaApiClient;
  readonly stopped: boolean;
  stopPropagation(): void;
  reply(message: OutgoingMessage, options?: RequestOptions & { autoEscape?: boolean }): Promise<unknown>;
  approve(options?: RequestDecisionOptions): Promise<unknown>;
  reject(reason?: string, options?: RequestDecisionOptions): Promise<unknown>;
  quickOperation(operation: JsonObject, options?: RequestOptions): Promise<unknown>;
}

export interface CommandOptions {
  prefixes?: string | string[];
  trim?: boolean;
  caseSensitive?: boolean;
}

export interface CommandMatch {
  command: string;
  text: string;
  args: string[];
  rest: string;
  prefix: string;
  match: RegExpMatchArray | null;
}

export type CommandHandler<TEvent extends OneBotMessageEvent = OneBotMessageEvent> = (
  event: TEvent,
  context: SnowLumaEventContext<TEvent> & { command: CommandMatch },
  match: CommandMatch,
) => MaybePromise;
