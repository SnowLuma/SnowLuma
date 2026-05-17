import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { createLogger } from '../utils/logger';
import type {
  HttpClientNetwork,
  HttpServerNetwork,
  JsonObject,
  MessageFormat,
  OneBotConfig,
  OneBotNetworks,
  WsClientNetwork,
  WsRole,
  WsServerNetwork,
} from './types';

const log = createLogger('OneBot.Config');

const CONFIG_DIR = 'config';
const DEFAULT_CONFIG_PATH = path.join(CONFIG_DIR, 'onebot.json');
const DEFAULT_ACCESS_TOKEN_BYTES = 32;

export function makeDefaultOneBotConfig(): OneBotConfig {
  return {
    networks: {
      httpServers: [{
        name: 'http-default',
        host: '0.0.0.0',
        port: 3000,
        path: '/',
        accessToken: generateAccessToken(),
        messageFormat: 'array',
        reportSelfMessage: false,
      }],
      httpClients: [],
      wsServers: [{
        name: 'ws-default',
        host: '0.0.0.0',
        port: 3001,
        path: '/',
        role: 'Universal',
        accessToken: generateAccessToken(),
        messageFormat: 'array',
        reportSelfMessage: false,
      }],
      wsClients: [],
    },
    musicSignUrl: '',
  };
}

function generateAccessToken(): string {
  return randomBytes(DEFAULT_ACCESS_TOKEN_BYTES).toString('base64url');
}

export interface LoadOneBotConfigOptions {
  /**
   * Persist the normalized config to disk when the file is missing or was
   * in legacy format. Default `false` so accidental call sites (read-only
   * GETs in particular) don't generate fresh access tokens, race on
   * concurrent writes, or surprise the operator with materialized files.
   * Pass `true` from boot / explicit POST handlers.
   */
  persistDefaults?: boolean;
}

export function loadOneBotConfig(uin: string, options: LoadOneBotConfigOptions = {}): OneBotConfig {
  ensureConfigDir();

  const perUinPath = path.join(CONFIG_DIR, `onebot_${uin}.json`);
  const globalRaw = tryLoadJson(DEFAULT_CONFIG_PATH);
  const perUinRaw = tryLoadJson(perUinPath);

  // Detect legacy on-disk format (top-level per-type arrays). We auto-migrate
  // these entries into `networks.*` and rewrite the file on the next save.
  const legacy = !!perUinRaw && hasLegacyTopLevel(perUinRaw);

  const sources: JsonObject[] = [];
  if (globalRaw) sources.push(globalRaw);
  if (perUinRaw) sources.push(perUinRaw);

  const config = fromJson(sources, !perUinRaw && !globalRaw);

  if (options.persistDefaults && (!perUinRaw || legacy)) {
    saveOneBotConfig(uin, config);
  }

  return config;
}

export function saveOneBotConfig(uin: string, config: OneBotConfig): void {
  ensureConfigDir();
  const perUinPath = path.join(CONFIG_DIR, `onebot_${uin}.json`);
  saveJson(perUinPath, toJsonObject(config));
}

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function toJsonObject(config: OneBotConfig): JsonObject {
  const nets = config.networks;
  return {
    networks: {
      httpServers: nets.httpServers.map(httpServerToJson),
      httpClients: nets.httpClients.map(httpClientToJson),
      wsServers: nets.wsServers.map(wsServerToJson),
      wsClients: nets.wsClients.map(wsClientToJson),
    },
    musicSignUrl: config.musicSignUrl ?? '',
  };
}

function applyBase(
  out: JsonObject,
  n: { name: string; enabled?: boolean; accessToken?: string; messageFormat: MessageFormat; reportSelfMessage: boolean },
): void {
  out.name = n.name;
  if (n.enabled === false) out.enabled = false;
  if (n.accessToken) out.accessToken = n.accessToken;
  out.messageFormat = n.messageFormat;
  out.reportSelfMessage = n.reportSelfMessage;
}

function httpServerToJson(n: HttpServerNetwork): JsonObject {
  const out: JsonObject = {};
  applyBase(out, n);
  out.host = n.host ?? '0.0.0.0';
  out.port = n.port;
  out.path = n.path ?? '/';
  return out;
}

function httpClientToJson(n: HttpClientNetwork): JsonObject {
  const out: JsonObject = {};
  applyBase(out, n);
  out.url = n.url;
  if (typeof n.timeoutMs === 'number' && n.timeoutMs > 0) out.timeoutMs = n.timeoutMs;
  return out;
}

function wsServerToJson(n: WsServerNetwork): JsonObject {
  const out: JsonObject = {};
  applyBase(out, n);
  out.host = n.host ?? '0.0.0.0';
  out.port = n.port;
  out.path = n.path ?? '/';
  out.role = n.role ?? 'Universal';
  return out;
}

function wsClientToJson(n: WsClientNetwork): JsonObject {
  const out: JsonObject = {};
  applyBase(out, n);
  out.url = n.url;
  out.role = n.role ?? 'Universal';
  out.reconnectIntervalMs =
    typeof n.reconnectIntervalMs === 'number' && Number.isFinite(n.reconnectIntervalMs)
      ? Math.max(1000, Math.trunc(n.reconnectIntervalMs))
      : 5000;
  return out;
}

function fromJson(sources: JsonObject[], freshInstall: boolean): OneBotConfig {
  // Legacy top-level scalars are pulled DOWN into each adapter on the first
  // load: the on-disk schema has no globals anymore, every adapter is
  // self-describing. We compute the legacy fallbacks here so that adapters
  // missing `messageFormat`/`reportSelfMessage` inherit them once and the
  // file is rewritten in normalized form.
  let legacyFormat: MessageFormat | undefined;
  let legacyReport: boolean | undefined;
  let musicSignUrl = '';
  for (const src of sources) {
    const mf = parseMessageFormat(src.messageFormat);
    if (mf) legacyFormat = mf;
    if (typeof src.reportSelfMessage === 'boolean') legacyReport = src.reportSelfMessage;
    if (typeof src.musicSignUrl === 'string') musicSignUrl = src.musicSignUrl;
  }
  const inheritedFormat: MessageFormat = legacyFormat ?? 'array';
  const inheritedReport: boolean = legacyReport ?? false;

  // Pluck per-type arrays from each source: prefer `networks.<kind>` over
  // legacy top-level arrays, but accept both. Later sources override earlier
  // ones at the network level (last write wins per `(kind, name)` pair).
  const adapterDefaults = { messageFormat: inheritedFormat, reportSelfMessage: inheritedReport };
  const httpServers = collectByName<HttpServerNetwork>(sources, 'httpServers', (raw) => parseHttpServer(raw, adapterDefaults));
  const httpClients = collectByName<HttpClientNetwork>(sources, 'httpClients', (raw) => parseHttpClient(raw, adapterDefaults), 'httpPostEndpoints');
  const wsServers = collectByName<WsServerNetwork>(sources, 'wsServers', (raw) => parseWsServer(raw, adapterDefaults));
  const wsClients = collectByName<WsClientNetwork>(sources, 'wsClients', (raw) => parseWsClient(raw, adapterDefaults));

  // Seed defaults ONLY for a brand-new install (no source files at all).
  // If the operator deliberately emptied every adapter, respect that and
  // do NOT silently revive default 0.0.0.0 listeners.
  if (
    freshInstall &&
    httpServers.length === 0 &&
    httpClients.length === 0 &&
    wsServers.length === 0 &&
    wsClients.length === 0
  ) {
    const defaults = makeDefaultOneBotConfig().networks;
    httpServers.push(...defaults.httpServers);
    wsServers.push(...defaults.wsServers);
  }

  const networks: OneBotNetworks = { httpServers, httpClients, wsServers, wsClients };
  return { networks, musicSignUrl };
}

function collectByName<T extends { name: string }>(
  sources: JsonObject[],
  kind: keyof OneBotNetworks,
  parse: (raw: JsonObject) => T | null,
  legacyKey?: string,
): T[] {
  const byName = new Map<string, T>();
  const order: string[] = [];

  let counter = 0;
  const ingest = (rawArr: unknown): void => {
    if (!Array.isArray(rawArr)) return;
    for (const raw of rawArr) {
      if (!isObject(raw)) continue;
      const parsed = parse(raw);
      if (!parsed) continue;
      const name = parsed.name && parsed.name.trim() ? parsed.name.trim() : pickAutoName(kind, byName, ++counter);
      parsed.name = name;
      if (!byName.has(name)) order.push(name);
      byName.set(name, parsed);
    }
  };

  for (const src of sources) {
    const nested = isObject(src.networks) ? (src.networks as JsonObject)[kind] : undefined;
    ingest(nested);
    if (legacyKey) ingest(src[legacyKey]);
    ingest(src[kind]);
  }

  return order.map((n) => byName.get(n)!);
}

function pickAutoName(kind: keyof OneBotNetworks, used: Map<string, unknown>, counter: number): string {
  const prefix =
    kind === 'httpServers' ? 'http' :
    kind === 'httpClients' ? 'httppost' :
    kind === 'wsServers' ? 'ws' :
    'wsclient';
  let candidate = `${prefix}-${counter}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${prefix}-${counter}`;
  }
  return candidate;
}

interface AdapterDefaults {
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}

function parseBase(value: JsonObject, defaults: AdapterDefaults) {
  return {
    name: asString(value.name),
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    accessToken: asString(value.accessToken) || undefined,
    messageFormat: parseMessageFormat(value.messageFormat) ?? defaults.messageFormat,
    reportSelfMessage:
      typeof value.reportSelfMessage === 'boolean' ? value.reportSelfMessage : defaults.reportSelfMessage,
  };
}

function parseHttpServer(value: JsonObject, defaults: AdapterDefaults): HttpServerNetwork | null {
  const port = asNumber(value.port, 0);
  if (port <= 0) return null;
  return clean({
    ...parseBase(value, defaults),
    host: asString(value.host, '0.0.0.0'),
    port,
    path: asString(value.path, '/'),
  });
}

function parseHttpClient(value: JsonObject, defaults: AdapterDefaults): HttpClientNetwork | null {
  const url = asString(value.url);
  if (!url) return null;
  const timeout = asNumber(value.timeoutMs, 0);
  return clean({
    ...parseBase(value, defaults),
    url,
    timeoutMs: timeout > 0 ? timeout : undefined,
  });
}

function parseWsServer(value: JsonObject, defaults: AdapterDefaults): WsServerNetwork | null {
  const port = asNumber(value.port, 0);
  if (port <= 0) return null;
  return clean({
    ...parseBase(value, defaults),
    host: asString(value.host, '0.0.0.0'),
    port,
    path: asString(value.path, '/'),
    role: asRole(value.role, 'Universal'),
  });
}

function parseWsClient(value: JsonObject, defaults: AdapterDefaults): WsClientNetwork | null {
  const url = asString(value.url);
  if (!url) return null;
  const reconnectIntervalMs = asNumber(value.reconnectIntervalMs, 5000);
  return clean({
    ...parseBase(value, defaults),
    url,
    role: asRole(value.role, 'Universal'),
    reconnectIntervalMs: Math.max(1000, reconnectIntervalMs),
  });
}

function hasLegacyTopLevel(raw: JsonObject): boolean {
  return (
    Array.isArray(raw.httpServers) ||
    Array.isArray(raw.httpPostEndpoints) ||
    Array.isArray(raw.wsServers) ||
    Array.isArray(raw.wsClients) ||
    typeof raw.messageFormat === 'string' ||
    typeof raw.reportSelfMessage === 'boolean'
  );
}

function parseMessageFormat(value: unknown): MessageFormat | undefined {
  if (value === 'array' || value === 'string') return value;
  return undefined;
}

function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function asRole(value: unknown, fallback: WsRole): WsRole {
  // Accept both uppercase (canonical) and lowercase (legacy on-disk) forms.
  // Lowercase values are auto-migrated to uppercase on the next save.
  const text = asString(value, fallback).toLowerCase();
  if (text === 'api') return 'Api';
  if (text === 'event') return 'Event';
  if (text === 'universal') return 'Universal';
  return fallback;
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.trunc(n));
  }
  return fallback;
}

function tryLoadJson(filePath: string): JsonObject | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch (err) {
    log.warn('config file %s is corrupt and will be ignored: %s', filePath, err instanceof Error ? err.message : String(err));
    return null;
  }
}

function saveJson(filePath: string, json: JsonObject): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), 'utf8');
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
