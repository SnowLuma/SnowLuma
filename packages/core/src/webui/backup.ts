// WebUI config backup/restore (Wave A2). Format: a zero-dep JSON bundle
//   { version, app, createdAt, files: { "<name>": { encoding, data } } }
// over an explicit allowlist (never a whole-dir sweep) so a stray/unknown file
// can't leak and an import can't path-traverse. Credentials (webui.json password
// hash + key.pem private key) are gated by a toggle on both export and import.
// cert.pem is public so it always travels.
//
// Pure functions here (read/write/snapshot injected) — the fs glue lives in
// server.ts. Restore is restart-to-apply, like the rest of A1.

export const BACKUP_VERSION = 1;
export const BACKUP_APP = 'snowluma';

export interface BackupFileSpec {
  /** Path relative to the config dir; also the bundle key. */
  name: string;
  binary: boolean;
  /** Sensitive (private key / password hash) — gated by the credentials toggle. */
  credential: boolean;
}

export const BACKUP_FILES: readonly BackupFileSpec[] = [
  { name: 'runtime.json', binary: false, credential: false },
  { name: 'ui.json', binary: false, credential: false },
  { name: 'onebot.json', binary: false, credential: false },
  { name: 'notifications.json', binary: false, credential: false },
  { name: 'cert.pem', binary: false, credential: false },
  { name: 'webui.json', binary: false, credential: true },
  { name: 'key.pem', binary: false, credential: true },
  { name: 'ui-assets/background', binary: true, credential: false },
];

const SPEC_BY_NAME = new Map(BACKUP_FILES.map((f) => [f.name, f]));

export interface BackupEntry { encoding: 'utf8' | 'base64'; data: string }
export interface Backup {
  version: number;
  app: string;
  createdAt?: string;
  files: Record<string, BackupEntry>;
}

/** Assemble a bundle from the allowlist. `readFile` returns null for missing. */
export function buildBackup(
  readFile: (name: string) => Buffer | null,
  opts: { includeCredentials: boolean },
  createdAt: string,
): Backup {
  const files: Record<string, BackupEntry> = {};
  for (const spec of BACKUP_FILES) {
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
    if (!SPEC_BY_NAME.has(name)) return { ok: false, error: `unknown file in backup: ${name}` };
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: `malformed entry: ${name}` };
    const e = entry as Record<string, unknown>;
    if (e.encoding !== 'utf8' && e.encoding !== 'base64') return { ok: false, error: `bad encoding for ${name}` };
    if (typeof e.data !== 'string') return { ok: false, error: `bad data for ${name}` };
  }
  return { ok: true, backup: { version: BACKUP_VERSION, app: BACKUP_APP, createdAt: typeof b.createdAt === 'string' ? b.createdAt : undefined, files: files as Record<string, BackupEntry> } };
}

/**
 * Apply a (already-validated) bundle. For each file: snapshot the current one
 * (so a bad restore is recoverable) then write the decoded bytes. Credential
 * files are skipped unless `restoreCredentials`.
 */
export function applyBackup(
  backup: Backup,
  io: { snapshot: (name: string) => void; write: (name: string, data: Buffer) => void },
  opts: { restoreCredentials: boolean },
): { restored: string[]; skipped: string[] } {
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const [name, entry] of Object.entries(backup.files)) {
    const spec = SPEC_BY_NAME.get(name);
    if (!spec) { skipped.push(name); continue; } // validated, but be defensive
    if (spec.credential && !opts.restoreCredentials) { skipped.push(name); continue; }
    const data = Buffer.from(entry.data, entry.encoding);
    io.snapshot(name);
    io.write(name, data);
    restored.push(name);
  }
  return { restored, skipped };
}
