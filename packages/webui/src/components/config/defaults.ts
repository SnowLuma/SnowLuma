// Per-network-kind metadata: localized title, summary projector for the
// list view, and factory for "create new" defaults. Centralised here so the
// page / list / dialog all agree on naming and shape and a new adapter
// kind only needs one entry in NETWORK_TABS to wire end-to-end.

import type {
  HttpClientNetwork,
  HttpServerNetwork,
  MessageFormat,
  NetworkKind,
  OneBotNetworks,
  WsClientNetwork,
  WsRole,
  WsServerNetwork,
} from '@/types';

export type TabKey = 'general' | NetworkKind;

export interface NetworkTabDescriptor<K extends NetworkKind> {
  key: K;
  /** Tab label and dialog title prefix. */
  title: string;
  /** Short subtitle shown under the tab when active. */
  description: string;
  /** Singular noun for "新建 / 编辑 X". */
  noun: string;
  /** Project the adapter into a short list-card summary string. */
  summarize: (item: OneBotNetworks[K][number]) => string;
  /** Factory producing a fresh adapter with a unique suffix in its name. */
  defaultEntry: (suffix: number) => OneBotNetworks[K][number];
}

function genToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const httpServersTab: NetworkTabDescriptor<'httpServers'> = {
  key: 'httpServers',
  title: 'HTTP API',
  description: '本地监听 HTTP 端口，OneBot 客户端发起请求',
  noun: 'HTTP API 服务',
  summarize: (it: HttpServerNetwork) => {
    const host = it.host?.trim() || '0.0.0.0';
    const path = (it.path?.trim() || '/').replace(/^\/?/, '/');
    return `${host}:${it.port}${path}`;
  },
  defaultEntry: (suffix): HttpServerNetwork => ({
    name: `http-${suffix}`,
    host: '0.0.0.0',
    port: 3000,
    path: '/',
    accessToken: genToken(),
    messageFormat: 'array',
    reportSelfMessage: false,
  }),
};

const httpClientsTab: NetworkTabDescriptor<'httpClients'> = {
  key: 'httpClients',
  title: 'HTTP 客户端',
  description: '主动向远端 URL POST 推送事件',
  noun: 'HTTP 推送客户端',
  summarize: (it: HttpClientNetwork) => it.url || '(未设置 URL)',
  defaultEntry: (suffix): HttpClientNetwork => ({
    name: `httppost-${suffix}`,
    url: 'http://127.0.0.1:5700',
    messageFormat: 'array',
    reportSelfMessage: false,
  }),
};

const wsServersTab: NetworkTabDescriptor<'wsServers'> = {
  key: 'wsServers',
  title: 'WS 服务端',
  description: '本地监听 WebSocket 端口，客户端建立持久连接',
  noun: 'WebSocket 服务',
  summarize: (it: WsServerNetwork) => {
    const host = it.host?.trim() || '0.0.0.0';
    const path = (it.path?.trim() || '/').replace(/^\/?/, '/');
    const role = it.role ?? 'Universal';
    return `${host}:${it.port}${path} · ${role}`;
  },
  defaultEntry: (suffix): WsServerNetwork => ({
    name: `ws-${suffix}`,
    host: '0.0.0.0',
    port: 3001,
    path: '/',
    role: 'Universal' as WsRole,
    accessToken: genToken(),
    messageFormat: 'array',
    reportSelfMessage: false,
  }),
};

const wsClientsTab: NetworkTabDescriptor<'wsClients'> = {
  key: 'wsClients',
  title: 'WS 客户端',
  description: '主动连接到外部 WebSocket 服务器（reverse-ws）',
  noun: 'WebSocket 反向客户端',
  summarize: (it: WsClientNetwork) => {
    const role = it.role ?? 'Universal';
    return `${it.url || '(未设置 URL)'} · ${role}`;
  },
  defaultEntry: (suffix): WsClientNetwork => ({
    name: `wsclient-${suffix}`,
    url: 'ws://127.0.0.1:8080/ws',
    role: 'Universal' as WsRole,
    reconnectIntervalMs: 5000,
    messageFormat: 'array',
    reportSelfMessage: false,
  }),
};

/**
 * Order here drives both the tab strip order and the dialog/page wiring.
 * Each entry stays strictly typed on its kind so callers get the narrow
 * adapter shape (no NetworkBase widening).
 */
export const NETWORK_TABS = {
  httpServers: httpServersTab,
  httpClients: httpClientsTab,
  wsServers: wsServersTab,
  wsClients: wsClientsTab,
} satisfies { [K in NetworkKind]: NetworkTabDescriptor<K> };

export const NETWORK_TAB_ORDER: NetworkKind[] = [
  'httpServers',
  'httpClients',
  'wsServers',
  'wsClients',
];

export const ALL_TABS: TabKey[] = ['general', ...NETWORK_TAB_ORDER];

/**
 * Find the smallest suffix N (starting at list.length + 1) such that
 * `factory(N).name` doesn't collide with any existing adapter. Used by
 * the page to seed a fresh-default adapter when the user clicks "create".
 */
export function nextUniqueSuffix(
  networks: { name: string }[],
  factory: (suffix: number) => { name: string },
): number {
  const used = new Set(networks.map((n) => n.name));
  let suffix = networks.length + 1;
  while (used.has(factory(suffix).name)) suffix += 1;
  return suffix;
}

// Re-exported for callers that just need to type a generic adapter.
export interface AdapterCommon {
  name: string;
  enabled?: boolean;
  accessToken?: string;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}
