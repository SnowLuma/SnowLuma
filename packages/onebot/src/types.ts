
import type { JsonObject, JsonValue } from '@snowluma/common/json';

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

export interface OneBotNetworks {
  httpServers: HttpServerNetwork[];
  httpClients: HttpClientNetwork[];
  wsServers: WsServerNetwork[];
  wsClients: WsClientNetwork[];
}

/**
 * Built-in status command settings. The trigger word is configurable;
 * defaults to `#sl` with exact case-insensitive matching.
 */
export interface StatusCommandConfig {
  /** Master on/off. Default `true`. */
  enabled: boolean;
  /**
   * When `true`, a matched status command is NOT forwarded to downstream
   * adapters (it is still cached, logged, and replied to). Default `false`.
   */
  swallow: boolean;
  /** Per-conversation reply cooldown in seconds. `0` disables it. Default `5`. */
  cooldownSeconds: number;

  /** Trigger word. Default `'#sl'`. Non-empty, max 32 chars. */
  trigger: string;
}

/**
 * Remote rkey fallback. QQ-NT image/file download URLs need a short-lived,
 * server-issued `rkey`; SnowLuma fetches it via OIDB 0x9067_202. On accounts
 * where that native fetch persistently returns nothing, every image would be
 * served as a bare URL the CDN rejects with `invalid rkey` (#156). When
 * `fallbackServers` is non-empty, SnowLuma asks those HTTP endpoints for an
 * rkey instead. OFF by default (empty list): no third-party server is ever
 * contacted unless you opt in by configuring your own endpoint.
 */
export interface RKeyConfig {
  /**
   * HTTP(S) endpoints returning `{ group_rkey, private_rkey, expired_time }`
   * (NapCat rkey-server format; an OneBot `{ retcode, data }` wrapper is also
   * accepted). Tried in order until one yields a usable rkey. Default `[]`.
   */
  fallbackServers: string[];
}

/** Per-UIN OneBot configuration. */
export interface OneBotConfig {
  networks: OneBotNetworks;
  /** Built-in `#sl` status command settings. Always present after normalization. */
  statusCommand: StatusCommandConfig;
  /** Which GLOBAL notification channels this account opts into (channel ids are
   *  validated slugs; channels themselves live in config/notifications.json).
   *  Always present after normalization. */
  notifications?: { channelIds: string[] };
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
export type { JsonArray, JsonObject, JsonPrimitive, JsonValue } from '@snowluma/common/json';

