import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ParserOptions {
  isServer: boolean;
  maxPayload: number;
  allowedRsv: number;
}

export interface ParsedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  rsv?: number;
}

export interface ParseResult {
  frames: ParsedFrame[];
  error?: boolean;
  code?: number;
  message?: string;
}

export interface ParserInstance {
  push(chunk: Buffer): ParseResult;
}

export interface NativeAddon {
  Parser: new (options: ParserOptions) => ParserInstance;
  buildFrame(
    opcode: number,
    fin: boolean,
    payload: Buffer,
    maskKey: Buffer | null,
    rsv: number,
  ): Buffer;
  computeAcceptKey(key: string): string;
}

function platformBinaryName(): string {
  return `websocket-${process.platform}-${process.arch}.node`;
}

// The same binary ships under several layouts, depending on whether we're
// running from source (tsx), from the bundled monorepo dist/, or from a
// flattened release zip. Probe each candidate in priority order.
function searchDirs(): string[] {
  return [
    // Released zip (flattened): <root>/native, called from <root>/index.mjs
    path.resolve(__dirname, 'native'),
    // Bundled into <root>/dist/index.mjs → natives at <root>/dist/native
    path.resolve(__dirname, '..', 'native'),
    // Dev (tsx) — packages/websocket/src → packages/runtime/native
    path.resolve(__dirname, '..', '..', 'runtime', 'native'),
    // Fallback when invoked from repo root
    path.resolve(process.cwd(), 'native'),
    path.resolve(process.cwd(), 'dist', 'native'),
    path.resolve(process.cwd(), 'packages', 'runtime', 'native'),
  ];
}

function resolveAddonPath(): string {
  const fileName = platformBinaryName();
  for (const dir of searchDirs()) {
    const full = path.join(dir, fileName);
    if (existsSync(full)) return full;
  }
  throw new Error(
    `[snowluma/websocket] native addon not found: ${fileName}. Searched: ${searchDirs().join(', ')}`,
  );
}

function loadAddon(): NativeAddon {
  const addonPath = resolveAddonPath();
  const mod = { exports: {} as Record<string, unknown> };
  // process.dlopen expects a NodeModule-shaped object; mod.exports is mutated in-place.
  (process as unknown as { dlopen: (m: { exports: unknown }, file: string) => void }).dlopen(
    mod,
    addonPath,
  );
  return mod.exports as unknown as NativeAddon;
}

// Local-only escape hatch: when SNOWLUMA_DEV_NO_NATIVE=1 is set, we return a
// stub addon that lets the process boot (so the WebUI / HTTP API can run on
// platforms without a prebuilt binary, e.g. darwin-arm64 dev machines). Any
// actual WebSocket parsing/serialization call will throw at use-time. This
// branch never triggers for normal users because the env var is opt-in.
function createStubAddon(reason: string): NativeAddon {
  const fail = (): never => {
    throw new Error(
      `[snowluma/websocket] native addon is stubbed (${reason}). ` +
        `Set SNOWLUMA_DEV_NO_NATIVE=0 (or unset) and provide the prebuilt binary to enable WebSocket I/O.`,
    );
  };
  class StubParser {
    constructor(_options: ParserOptions) {}
    push(_chunk: Buffer): ParseResult {
      return fail();
    }
  }
  console.warn(
    `[snowluma/websocket] WARNING: using stub addon (${reason}). WebSocket features are disabled.`,
  );
  return {
    Parser: StubParser as unknown as NativeAddon['Parser'],
    buildFrame: fail as unknown as NativeAddon['buildFrame'],
    computeAcceptKey: fail as unknown as NativeAddon['computeAcceptKey'],
  };
}

function tryLoad(): NativeAddon {
  const devSkip = process.env.SNOWLUMA_DEV_NO_NATIVE === '1';
  try {
    return loadAddon();
  } catch (err) {
    if (devSkip) {
      return createStubAddon((err as Error).message);
    }
    throw err;
  }
}

const addon: NativeAddon = tryLoad();
export default addon;
