import type { JsonObject, JsonValue } from '../types';

/**
 * Hardcoded trigger for the built-in status command — exact match,
 * case-insensitive, after trimming. Intentionally NOT configurable: the
 * `statusCommand.enabled` toggle is the only knob (the gate is on/off, not
 * the word).
 */
export const STATUS_COMMAND_TRIGGER = '#sl';

/**
 * True iff `message` is exactly the trigger: a single `text` segment (or a
 * bare string for string-format adapters) whose trimmed, lowercased content
 * equals {@link STATUS_COMMAND_TRIGGER}.
 *
 * Reads the segment array rather than `raw_message` to avoid CQ-encoding
 * ambiguity, and rejects mixed-segment messages (`#sl` + image/at/reply) so
 * only a pure `#sl` triggers — no `startsWith`, so `#slogan` never matches.
 */
export function matchesStatusCommand(message: JsonValue | undefined): boolean {
  if (typeof message === 'string') {
    return normalize(message) === STATUS_COMMAND_TRIGGER;
  }
  if (!Array.isArray(message) || message.length !== 1) return false;
  const seg = message[0];
  if (!isObject(seg) || seg.type !== 'text') return false;
  const data = isObject(seg.data) ? seg.data : null;
  const text = data && typeof data.text === 'string' ? data.text : '';
  return normalize(text) === STATUS_COMMAND_TRIGGER;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a reply is allowed now given the last reply time + cooldown.
 * `cooldownSeconds <= 0` disables the cooldown entirely.
 */
export function statusCooldownElapsed(
  lastRepliedAtMs: number | undefined,
  nowMs: number,
  cooldownSeconds: number,
): boolean {
  if (lastRepliedAtMs === undefined) return true;
  if (cooldownSeconds <= 0) return true;
  return nowMs - lastRepliedAtMs >= cooldownSeconds * 1000;
}

export interface StatusInfo {
  version: string;
  platform: string;
  arch: string;
  uptimeMs: number;
}

/** Render the public-safe `#sl` reply: version + platform/arch + uptime. */
export function buildStatusText(info: StatusInfo): string {
  return [
    'SnowLuma 状态',
    `版本: ${info.version}`,
    `平台: ${info.platform}-${info.arch}`,
    `运行时长: ${formatUptime(info.uptimeMs)}`,
  ].join('\n');
}

/** Human-readable uptime (zh-CN), dropping leading zero units. */
export function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}天 ${hours}小时 ${minutes}分钟`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟 ${seconds}秒`;
  return `${seconds}秒`;
}
