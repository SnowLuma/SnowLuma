import type { MessageFormat, OneBotConfig } from '@/types';

/**
 * Anti-corruption layer for the per-UIN config payload. Older backends emit
 * `messageFormat` / `reportSelfMessage` at the top level instead of per
 * adapter, and may omit them on adapters entirely. This collapses both shapes
 * into the canonical {@link OneBotConfig} the editor expects.
 */
export function normalizeOneBotConfig(raw: unknown): OneBotConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const nets = (cfg.networks as Record<string, unknown> | undefined) ?? {};
  const legacyFormat: MessageFormat = cfg.messageFormat === 'string' ? 'string' : 'array';
  const legacyReport = !!cfg.reportSelfMessage;

  const normalize = (item: Record<string, unknown>): Record<string, unknown> => ({
    ...item,
    messageFormat: item.messageFormat === 'string' ? 'string' : legacyFormat,
    reportSelfMessage:
      typeof item.reportSelfMessage === 'boolean' ? item.reportSelfMessage : legacyReport,
  });

  const list = (x: unknown): Record<string, unknown>[] =>
    Array.isArray(x) ? x.map((it) => normalize(it as Record<string, unknown>)) : [];

  return {
    networks: {
      httpServers: list(nets.httpServers) as unknown as OneBotConfig['networks']['httpServers'],
      httpClients: list(nets.httpClients) as unknown as OneBotConfig['networks']['httpClients'],
      wsServers: list(nets.wsServers) as unknown as OneBotConfig['networks']['wsServers'],
      wsClients: list(nets.wsClients) as unknown as OneBotConfig['networks']['wsClients'],
    },
    musicSignUrl: typeof cfg.musicSignUrl === 'string' ? cfg.musicSignUrl : undefined,
  };
}
