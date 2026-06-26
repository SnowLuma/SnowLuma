// Pure validator for the POST /api/system/settings body. Rejects clearly-bad
// input with a message (→ 400) rather than silently normalizing it, then hands
// a clean patch to updateRuntimeConfig. Wire field `tlsEnabled` maps to the
// nested `webuiTls.enabled`.

import type { RuntimeConfig } from '@snowluma/common/runtime';

export type SettingsPatch = Partial<Pick<RuntimeConfig, 'webuiPort' | 'webuiHost' | 'webuiTls' | 'trustProxy'>>;

export type CoerceResult =
  | { ok: true; patch: SettingsPatch }
  | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function coerceSettingsPatch(body: unknown): CoerceResult {
  if (!isObject(body)) return { ok: false, error: 'body must be an object' };
  const patch: SettingsPatch = {};

  if ('webuiPort' in body) {
    const p = body.webuiPort;
    if (typeof p !== 'number' || !Number.isInteger(p) || p <= 0 || p > 65535) {
      return { ok: false, error: 'webuiPort must be an integer in 1..65535' };
    }
    patch.webuiPort = p;
  }

  if ('webuiHost' in body) {
    if (typeof body.webuiHost !== 'string' || !body.webuiHost.trim()) {
      return { ok: false, error: 'webuiHost must be a non-empty string' };
    }
    patch.webuiHost = body.webuiHost.trim();
  }

  if ('tlsEnabled' in body) {
    if (typeof body.tlsEnabled !== 'boolean') {
      return { ok: false, error: 'tlsEnabled must be a boolean' };
    }
    patch.webuiTls = { enabled: body.tlsEnabled };
  }

  if ('trustProxy' in body) {
    if (typeof body.trustProxy !== 'string') {
      return { ok: false, error: 'trustProxy must be a string' };
    }
    patch.trustProxy = body.trustProxy;
  }

  return { ok: true, patch };
}
