import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(decimals)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 秒';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 时`);
  if (m || (!d && !h)) parts.push(`${m} 分`);
  return parts.join(' ');
}

/** Fine desktop pointer only. iPad + mouse still reports `any-pointer: coarse`. */
export const FINE_POINTER_QUERY =
  '(hover: hover) and (pointer: fine) and (not (any-pointer: coarse))';

/** Safari / iOS WebKit need the `<a>` in the document and a delayed revoke. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Clipboard write that still works on LAN HTTP and inside a modal focus trap. */
/** WebKit `<input type="color">` only accepts `#rrggbb`. */
export function toColorInputValue(raw: string, fallback = '#0ea5e9'): string {
  const v = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/u.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/u.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return fallback;
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* insecure origin / permission — fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0.01';
    const host = document.querySelector('[role="dialog"]') ?? document.body;
    host.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    host.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
