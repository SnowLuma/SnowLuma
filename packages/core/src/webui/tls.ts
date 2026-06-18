// WebUI TLS helpers. Cert/key live as config/cert.pem + config/key.pem
// (NapCat-aligned, self-contained, travels in A2 backups). Two pure-ish
// helpers: validate a pasted pair (save path) and resolve the on-disk pair
// (boot path). Validation is `tls.createSecureContext` — it parses the PEM
// and checks the key matches the cert; expiry is NOT checked here.

import fs from 'fs';
import path from 'path';
import tls from 'tls';

export interface TlsValidation {
  ok: boolean;
  reason?: string;
}

export interface TlsResolution {
  ok: boolean;
  cert?: Buffer;
  key?: Buffer;
  reason?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parse-validate a cert/key pair (used by the save endpoint before writing). */
export function validateTlsPair(cert: string | Buffer, key: string | Buffer): TlsValidation {
  if (!cert || !cert.toString().trim()) return { ok: false, reason: 'certificate is empty' };
  if (!key || !key.toString().trim()) return { ok: false, reason: 'private key is empty' };
  try {
    tls.createSecureContext({ cert, key });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `invalid cert/key: ${errMsg(e)}` };
  }
}

/** Load + validate config/cert.pem + config/key.pem from `configDir`. */
export function resolveTlsContext(configDir: string): TlsResolution {
  const certPath = path.join(configDir, 'cert.pem');
  const keyPath = path.join(configDir, 'key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    return { ok: false, reason: 'cert.pem or key.pem missing in config dir' };
  }
  let cert: Buffer;
  let key: Buffer;
  try {
    cert = fs.readFileSync(certPath);
    key = fs.readFileSync(keyPath);
  } catch (e) {
    return { ok: false, reason: `failed to read cert/key: ${errMsg(e)}` };
  }
  const valid = validateTlsPair(cert, key);
  if (!valid.ok) return { ok: false, reason: valid.reason };
  return { ok: true, cert, key };
}
