// Plain JSON types now live in @snowluma/common/json so @snowluma/protocol
// (event-format / receive parsers) can talk about JSON payloads without
// importing OneBot. Re-exported here so the legacy import shape stays
// supported — `import { JsonValue } from '<…>/onebot/types'` keeps working.
export type { JsonPrimitive, JsonValue, JsonObject, JsonArray } from '@snowluma/common/json';
import type { JsonValue, JsonObject } from '@snowluma/common/json';

export interface ApiResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data: JsonValue;
  echo?: JsonValue;
  wording?: string;
}

export interface OneBotRequest {
  action: string;
  params?: JsonObject;
  echo?: JsonValue;
}

export type WsRole = 'Api' | 'Event' | 'Universal';

export type MessageFormat = 'array' | 'string';

export type NetworkKind = 'httpServers' | 'httpClients' | 'wsServers' | 'wsClients';

/**
 * Fields shared by every network adapter. `messageFormat` and
 * `reportSelfMessage` live on the adapter itself — there is no global default
 * fallback; each adapter is fully self-describing.
 *
 * The `name` is a free-form identifier scoped to the adapter's array; it is
 * used for hot-reload bookkeeping and as a label in logs / WebUI.
 */
export interface NetworkBase {
  name: string;
  /** When `false`, the adapter is configured but inactive. Defaults to `true`. */
  enabled?: boolean;
  accessToken?: string;
  /** Output format for this adapter. */
  messageFormat: MessageFormat;
  /** When `true`, this adapter receives `post_type='message_sent'` self events. */
  reportSelfMessage: boolean;
}

export interface HttpServerNetwork extends NetworkBase {
  host?: string;
  port: number;
  path?: string;
}

export interface HttpClientNetwork extends NetworkBase {
  url: string;
  timeoutMs?: number;
}

export interface WsServerNetwork extends NetworkBase {
  host?: string;
  port: number;
  path?: string;
  role?: WsRole;
}

export interface WsClientNetwork extends NetworkBase {
  url: string;
  role?: WsRole;
  reconnectIntervalMs?: number;
}

/**
 * Network adapters grouped by type. Each adapter is identified by `name`
 * within its own array; hot-reload works on a per-(kind, name) basis.
 */
export interface OneBotNetworks {
  httpServers: HttpServerNetwork[];
  httpClients: HttpClientNetwork[];
  wsServers: WsServerNetwork[];
  wsClients: WsClientNetwork[];
}

/** Per-UIN OneBot configuration. */
export interface OneBotConfig {
  networks: OneBotNetworks;
  /** Music card signing service URL (optional). */
  musicSignUrl?: string;
}

export interface MessageMeta {
  isGroup: boolean;
  targetId: number;
  sequence: number;
  eventName: string;
  clientSequence: number;
  random: number;
  timestamp: number;
}

export const RETCODE = {
  ACTION_FAILED: 100,
  INTERNAL_ERROR: 1200,
  BAD_REQUEST: 1400,
  UNKNOWN_ACTION: 1404,
} as const;

export function okResponse(data: JsonValue = null): ApiResponse {
  return {
    status: 'ok',
    retcode: 0,
    data,
  };
}

export function failedResponse(retcode: number, wording: string): ApiResponse {
  return {
    status: 'failed',
    retcode,
    data: null,
    wording,
  };
}
