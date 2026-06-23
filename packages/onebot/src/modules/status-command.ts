import { extractTags, getMockSystem, simplifyDistro } from '@snowluma/core/system-info';
import type { SystemInfo } from '@snowluma/core/system-info';
import type { JsonObject, JsonValue, StatusCommandMatchMode, StatusCommandPlatformDetail } from '../types';

/** Strip leading JS regex inline flags (currently only `(?i)`) from a
 *  trigger string and return the cleaned pattern + accumulated flags.
 *  Returns `null` when the pattern is empty after stripping. */
export function parseRegexTrigger(trigger: string): { pattern: string; flags: string } | null {
  let pattern = trigger;
  let flags = '';
  while (pattern.startsWith('(?') && pattern.length > 3) {
    if (pattern[2] === 'i' && pattern[3] === ')') {
      flags += 'i';
      pattern = pattern.slice(4);
    } else { break; }
  }
  if (pattern.length === 0) return null;
  return { pattern, flags };
}

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
        const parsed = parseRegexTrigger(trigger);
        if (parsed === null) return false;
        return new RegExp(parsed.pattern, parsed.flags).test(text);
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
    switch (platformDetail) {
      case 'brief':
        lines.push(`平台: ${info.platform}-${info.arch}`);
        break;
      case 'detailed':
        if (systemInfo) {
          renderDetailedPlatform(lines, systemInfo);
        } else {
          lines.push(`平台: ${info.platform}-${info.arch}`);
        }
        break;
      case 'summary':
        if (systemInfo) {
          renderSummaryPlatform(lines, systemInfo);
        } else {
          lines.push(`平台: ${info.platform}-${info.arch}`);
        }
        break;
      case 'fuzzy':
        renderFuzzyPlatform(lines);
        break;
    }
  }
  lines.push(`运行时长: ${formatUptime(info.uptimeMs)}`);
  return lines.join('\n');
}

function renderPlatformLines(
  lines: string[],
  distroName: string,
  tags: string[],
  archLabel: string,
  kernel?: string,
): void {
  const indent = '         ';
  lines.push(`平台: ${distroName}`);
  if (kernel) lines.push(`${indent}[kernel ${kernel}]`);
  for (const tag of tags) lines.push(`${indent}[${tag}]`);
  lines.push(`${indent}${archLabel}`);
}

function renderDetailedPlatform(lines: string[], sys: SystemInfo): void {
  const { cleanName, tags } = extractTags(sys.distro);
  const kernelMatch = cleanName.match(/\(kernel\s+([^)]+)\)/);
  const distroName = kernelMatch
    ? cleanName.replace(/\s*\(kernel [^)]+\)/, '').trim()
    : cleanName;
  if (tags.length > 0 || kernelMatch) {
    renderPlatformLines(lines, distroName, tags, sys.archLabel, kernelMatch?.[1]);
  } else {
    lines.push(`平台: ${distroName} ${sys.archLabel}`);
  }
}

function renderSummaryPlatform(lines: string[], sys: SystemInfo): void {
  const { cleanName, tags } = extractTags(sys.distro);
  const simplified = simplifyDistro(cleanName);
  if (tags.length > 0) {
    renderPlatformLines(lines, simplified, tags, sys.archLabel);
  } else {
    lines.push(`平台: ${simplified} ${sys.archLabel}`);
  }
}

function renderFuzzyPlatform(lines: string[]): void {
  const mock = getMockSystem();
  const { cleanName, tags } = extractTags(mock);
  const lastSpace = cleanName.lastIndexOf(' ');
  const distro = lastSpace > 0 ? cleanName.slice(0, lastSpace) : cleanName;
  const archLabel = lastSpace > 0 ? cleanName.slice(lastSpace + 1) : cleanName;
  renderPlatformLines(lines, distro, tags, archLabel);
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
