import type { MessageFormat, OneBotConfig, StatusCommandConfig } from '@/types';

const DEFAULT_STATUS_COMMAND: StatusCommandConfig = {
  enabled: true,
  swallow: false,
  cooldownSeconds: 5,
  trigger: '#sl',
};

/** Fill the `statusCommand` block with defaults when the backend omits or
 *  partially supplies it (older configs predate the feature). */
function normalizeStatusCommand(raw: unknown): StatusCommandConfig {
  const src = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_STATUS_COMMAND.enabled,
    swallow: typeof src.swallow === 'boolean' ? src.swallow : DEFAULT_STATUS_COMMAND.swallow,
    cooldownSeconds:
      typeof src.cooldownSeconds === 'number' && Number.isFinite(src.cooldownSeconds) && src.cooldownSeconds >= 0
        ? Math.trunc(src.cooldownSeconds)
        : DEFAULT_STATUS_COMMAND.cooldownSeconds,
    trigger: typeof src.trigger === 'string' && src.trigger.trim().length > 0 && !/[\r\n]/.test(src.trigger)
      ? src.trigger.trim().slice(0, 32)
      : DEFAULT_STATUS_COMMAND.trigger,
  };
}

/** Keep only string channel ids (the server re-validates slugs on save). */
function normalizeNotifications(raw: unknown): { channelIds: string[] } {
  const src = (raw ?? {}) as Record<string, unknown>;
  const channelIds = Array.isArray(src.channelIds)
    ? src.channelIds.filter((x): x is string => typeof x === 'string')
    : [];
  return { channelIds };
}

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
    statusCommand: normalizeStatusCommand(cfg.statusCommand),
    notifications: normalizeNotifications(cfg.notifications),
  };
}
