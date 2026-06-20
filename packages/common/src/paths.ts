import fs from 'fs';
import path from 'path';

export const DEFAULT_CONFIG_DIR = 'config';

export function getConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SNOWLUMA_CONFIG_DIR;
  if (typeof raw !== 'string') return DEFAULT_CONFIG_DIR;
  const dir = raw.trim();
  return dir.length > 0 ? dir : DEFAULT_CONFIG_DIR;
}

export function configPath(...parts: string[]): string {
  return path.join(getConfigDir(), ...parts);
}

export function ensureConfigDir(): string {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
