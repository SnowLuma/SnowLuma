// WebUI config backup/restore (Wave A2). Format: a zero-dep JSON bundle
//   { version, app, createdAt, files: { "<name>": { encoding, data } } }
// over an explicit allowlist (never a whole-dir sweep) so a stray/unknown file
// can't leak and an import can't path-traverse.
//
// Credentials are gated by a toggle on both export and import. The credential
// set is: webui.json (password hash), key.pem (TLS private key), AND every
// OneBot config (onebot.json + per-account onebot_<uin>.json) — those carry the
// OneBot access token, so a no-credentials backup must NOT include them.
// cert.pem is public so it always travels.
//
// Pure functions here (read/list/decode); the fs glue (atomic two-phase write,
// snapshot) lives in server.ts. Restore is restart-to-apply, like A1.

export const BACKUP_VERSION = 1;
export const BACKUP_APP = 'snowluma';

export interface BackupFileSpec {
  /** Path relative to the config dir; also the bundle key. */
  name: string;
  binary: boolean;
  /** Sensitive (private key / password hash / access token) — credential-gated. */
  credential: boolean;
}

/** Static allowlist. Per-account `onebot_<uin>.json` are matched by pattern. */
export const BACKUP_FILES: readonly BackupFileSpec[] = [
  { name: 'runtime.json', binary: false, credential: false },
  { name: 'ui.json', binary: false, credential: false },
  { name: 'notifications.json', binary: false, credential: false },
  // Global all-accounts SnowLuma settings (rkey fallback servers, …). Same
  // class as notifications.json: global, opt-in, non-credential.
  { name: 'snowluma.json', binary: false, credential: false },
  { name: 'cert.pem', binary: false, credential: false },
  { name: 'ui-assets/background', binary: true, credential: false },
  { name: 'webui.json', binary: false, credential: true },
  { name: 'key.pem', binary: false, credential: true },
  // OneBot config carries the access token → credential.
  { name: 'onebot.json', binary: false, credential: true },
];

const SPEC_BY_NAME = new Map(BACKUP_FILES.map((f) => [f.name, f]));
const PER_UIN_ONEBOT = /^onebot_\d+\.json$/;

/** Resolve a file name (static or per-uin onebot pattern) to its spec, or null. */
export function specFor(name: string): BackupFileSpec | null {
  const s = SPEC_BY_NAME.get(name);
  if (s) return s;
  if (PER_UIN_ONEBOT.test(name)) return { name, binary: false, credential: true };
  return null;
}

export interface BackupEntry { encoding: 'utf8' | 'base64'; data: string }
export interface Backup {
  version: number;
  app: string;
  createdAt?: string;
  files: Record<string, BackupEntry>;
}

/**
 * Assemble a bundle from the allowlist plus any per-account onebot files.
 * `readFile` returns null for missing.
 */
export function buildBackup(
  readFile: (name: string) => Buffer | null,
  perUinOnebotNames: readonly string[],
  opts: { includeCredentials: boolean },
  createdAt: string,
): Backup {
  const files: Record<string, BackupEntry> = {};
  const all: BackupFileSpec[] = [
    ...BACKUP_FILES,
    ...perUinOnebotNames.filter((n) => PER_UIN_ONEBOT.test(n)).map((n) => ({ name: n, binary: false, credential: true })),
  ];
  for (const spec of all) {
    if (spec.credential && !opts.includeCredentials) continue;
    const buf = readFile(spec.name);
    if (!buf) continue;
    files[spec.name] = spec.binary
      ? { encoding: 'base64', data: buf.toString('base64') }
      : { encoding: 'utf8', data: buf.toString('utf8') };
  }
  return { version: BACKUP_VERSION, app: BACKUP_APP, createdAt, files };
}

/** Validate a parsed bundle wholesale — any defect rejects the whole import. */
export function validateBackup(parsed: unknown): { ok: true; backup: Backup } | { ok: false; error: string } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'backup must be an object' };
  }
  const b = parsed as Record<string, unknown>;
  if (b.app !== BACKUP_APP) return { ok: false, error: 'not a SnowLuma backup' };
  if (b.version !== BACKUP_VERSION) return { ok: false, error: `unsupported backup version ${String(b.version)}` };
  if (typeof b.files !== 'object' || b.files === null || Array.isArray(b.files)) {
    return { ok: false, error: 'backup.files must be an object' };
  }
  const files = b.files as Record<string, unknown>;
  for (const [name, entry] of Object.entries(files)) {
    if (!specFor(name)) return { ok: false, error: `unknown file in backup: ${name}` };
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: `malformed entry: ${name}` };
    const e = entry as Record<string, unknown>;
    if (e.encoding !== 'utf8' && e.encoding !== 'base64') return { ok: false, error: `bad encoding for ${name}` };
    if (typeof e.data !== 'string') return { ok: false, error: `bad data for ${name}` };
  }
  return { ok: true, backup: { version: BACKUP_VERSION, app: BACKUP_APP, createdAt: typeof b.createdAt === 'string' ? b.createdAt : undefined, files: files as Record<string, BackupEntry> } };
}

/**
 * Decide what a (validated) bundle would restore: decode each non-skipped file
 * to bytes. Pure — the caller (server.ts) does the atomic two-phase fs write so
 * a mid-restore failure can't leave a half-applied live config. Credential
 * files are skipped unless `restoreCredentials`.
 */
export function planRestore(
  backup: Backup,
  opts: { restoreCredentials: boolean },
): { restore: Array<{ name: string; data: Buffer }>; skipped: string[] } {
  const restore: Array<{ name: string; data: Buffer }> = [];
  const skipped: string[] = [];
  for (const [name, entry] of Object.entries(backup.files)) {
    const spec = specFor(name);
    if (!spec) { skipped.push(name); continue; } // validated, but be defensive
    if (spec.credential && !opts.restoreCredentials) { skipped.push(name); continue; }
    restore.push({ name, data: Buffer.from(entry.data, entry.encoding) });
  }
  return { restore, skipped };
}
