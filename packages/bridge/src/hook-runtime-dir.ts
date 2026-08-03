import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

export interface HookRuntimeDirDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  ownUid?: number;
  readText?: (file: string) => string;
}

function configuredDirectory(value: string | undefined, variable: string): string | null {
  if (!value) return null;
  if (!path.isAbsolute(value)) {
    throw new Error(`${variable} must be an absolute path`);
  }
  return value;
}

function parseProcessEnvironment(raw: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    result[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return result;
}

function parseRealUid(status: string): number | null {
  const match = /^Uid:\s+(\d+)/m.exec(status);
  if (!match) return null;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function isProcessGoneError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownRuntimeDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  ownUid: number,
): string {
  const explicit = configuredDirectory(
    env.SNOWLUMA_HOOK_RUNTIME_DIR,
    'SNOWLUMA_HOOK_RUNTIME_DIR',
  );
  if (explicit) return explicit;

  const xdg = configuredDirectory(env.XDG_RUNTIME_DIR, 'XDG_RUNTIME_DIR');
  if (xdg) return xdg;

  if (platform === 'darwin') {
    const tmpdir = configuredDirectory(env.TMPDIR, 'TMPDIR');
    if (tmpdir) return path.join(tmpdir, 'snowluma-hook');
  }
  return `/tmp/snowluma-${ownUid}`;
}

/**
 * Resolve the socket directory for the target QQ process. The supervisor may
 * run under a different user, so its own runtime directory is not authoritative.
 */
export function resolveHookRuntimeDir(
  targetPid?: number,
  deps: HookRuntimeDirDeps = {},
): string {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const ownUid = deps.ownUid
    ?? (typeof process.geteuid === 'function' ? process.geteuid() : os.userInfo().uid);
  const readText = deps.readText ?? ((file: string) => readFileSync(file, 'utf8'));

  if (platform !== 'linux' || !Number.isSafeInteger(targetPid) || targetPid! <= 0) {
    return ownRuntimeDir(platform, env, ownUid);
  }

  let environError: unknown;
  try {
    const targetEnv = parseProcessEnvironment(readText(`/proc/${targetPid}/environ`));
    const explicit = configuredDirectory(
      targetEnv.SNOWLUMA_HOOK_RUNTIME_DIR,
      `QQ process ${targetPid} SNOWLUMA_HOOK_RUNTIME_DIR`,
    );
    if (explicit) return explicit;
    const xdg = configuredDirectory(
      targetEnv.XDG_RUNTIME_DIR,
      `QQ process ${targetPid} XDG_RUNTIME_DIR`,
    );
    if (xdg) return xdg;
    environError = new Error('runtime directory is not present');
  } catch (error) {
    // An invalid explicit path is configuration corruption and must remain
    // visible. Permission/race failures are expected when /proc disappears;
    // the status-file fallback below can still recover the target uid.
    if (error instanceof Error && error.message.includes('must be an absolute path')) {
      throw error;
    }
    environError = error;
  }

  let statusError: unknown;
  try {
    const uid = parseRealUid(readText(`/proc/${targetPid}/status`));
    if (uid !== null) return `/tmp/snowluma-${uid}`;
    statusError = new Error('real uid is not available');
  } catch (error) {
    statusError = error;
  }

  if (isProcessGoneError(statusError)
    && (isProcessGoneError(environError)
      || (environError instanceof Error
        && environError.message === 'runtime directory is not present'))) {
    return ownRuntimeDir(platform, env, ownUid);
  }

  throw new Error(
    `cannot resolve hook runtime directory for PID ${targetPid}: `
      + `environment=${errorMessage(environError)}; status=${errorMessage(statusError)}`,
  );
}
