import { isIP } from 'node:net';

export type ListenerExposureCheck =
  | { ok: true }
  | { ok: false; code: 'invalid-bind-host' | 'tls-pair-required' };

/** TCP bind-host accepted by WebUI Listener Exposure (settings, restore, boot). */
export function isValidBindHost(value: string): boolean {
  const host = value.trim();
  if (!host || host !== value || host.length > 253 || /[\s/?#@]/u.test(host)) return false;
  if (host.includes(':')) return isIP(host) === 6;
  if (/^[\d.]+$/.test(host)) {
    return isIP(host) === 4;
  }
  const normalized = host.endsWith('.') ? host.slice(0, -1) : host;
  return normalized.split('.').every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label));
}

export function checkListenerExposure(input: {
  webuiHost: string;
  tlsEnabled: boolean;
  pairOk: boolean;
}): ListenerExposureCheck {
  if (!isValidBindHost(input.webuiHost)) return { ok: false, code: 'invalid-bind-host' };
  if (input.tlsEnabled && !input.pairOk) return { ok: false, code: 'tls-pair-required' };
  return { ok: true };
}
