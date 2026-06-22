import { getMockSystem, simplifyDistro } from '@snowluma/core/system-info';
import type { SystemInfo } from '@snowluma/core/system-info';
import type { JsonObject, JsonValue, StatusCommandMatchMode, StatusCommandPlatformDetail } from '../types';

/** ~40 half-width chars fits ~2 lines on mobile QQ in portrait. */
const QQ_LINE_LIMIT = 38;

/**
 * True iff `message` matches the given trigger using the given match mode.
 *
 * Only a single text segment (or a bare string) is accepted — mixed-segment
 * messages (e.g. `#sl` + image) never match, regardless of mode.
 */
export function matchesStatusCommand(
  message: JsonValue | undefined,
  trigger: string,
  matchMode: StatusCommandMatchMode,
): boolean {
  if (typeof message === 'string') {
    return testMatch(message, trigger, matchMode);
  }
  if (!Array.isArray(message) || message.length !== 1) return false;
  const seg = message[0];
  if (!isObject(seg) || seg.type !== 'text') return false;
  const data = isObject(seg.data) ? seg.data : null;
  const text = data && typeof data.text === 'string' ? data.text : '';
  return testMatch(text, trigger, matchMode);
}

function testMatch(text: string, trigger: string, mode: StatusCommandMatchMode): boolean {
  switch (mode) {
    case 'exact':
      return normalize(text) === normalize(trigger);
    case 'prefix':
      return normalize(text).startsWith(normalize(trigger));
    case 'contains':
      return normalize(text).includes(normalize(trigger));
    case 'regex':
      try {
        let pattern = trigger;
        let flags = '';
        while (pattern.startsWith('(?') && pattern.length > 2) {
          const needle = pattern[2];
          if (needle === 'i') { flags += 'i'; pattern = pattern.slice(4); }
          else { break; }
        }
        return new RegExp(pattern, flags).test(text);
      } catch { return false; }
  }
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

/** Render the status reply with configurable platform detail. */
export function buildStatusText(
  info: StatusInfo,
  showPlatform: boolean,
  platformDetail: StatusCommandPlatformDetail,
  systemInfo?: SystemInfo,
): string {
  const lines = ['SnowLuma 状态'];
  lines.push(`版本: ${info.version}`);
  if (showPlatform) {
    const platformLine = buildPlatformLine(info, platformDetail, systemInfo);
    // Wrap long lines for mobile QQ (~2 lines max on phone screen).
    if (platformLine.length > QQ_LINE_LIMIT) {
      const splitAt = platformLine.indexOf(' · ');
      if (splitAt > 0 && splitAt < QQ_LINE_LIMIT) {
        lines.push(platformLine.slice(0, splitAt));
        lines.push(`架构: ${platformLine.slice(splitAt + 3)}`);
      } else {
        lines.push(platformLine.slice(0, QQ_LINE_LIMIT));
        lines.push(platformLine.slice(QQ_LINE_LIMIT));
      }
    } else {
      lines.push(platformLine);
    }
  }
  lines.push(`运行时长: ${formatUptime(info.uptimeMs)}`);
  return lines.join('\n');
}

function buildPlatformLine(
  info: StatusInfo,
  detail: StatusCommandPlatformDetail,
  sys?: SystemInfo,
): string {
  switch (detail) {
    case 'brief':
      return `平台: ${info.platform}-${info.arch}`;
    case 'summary':
      return `平台: ${sys ? `${simplifyDistro(sys.distro)} ${sys.archLabel}` : `${info.platform}-${info.arch}`}`;
    case 'detailed':
      return `平台: ${sys ? `${sys.distro} · ${sys.archLabel}` : `${info.platform}-${info.arch}`}`;
    case 'fuzzy':
      return `平台: ${getMockSystem()}`;
  }
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
