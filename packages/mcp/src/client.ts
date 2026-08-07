// Thin HTTP bridge to a running OneBot instance.
//
// The OneBot v11 HTTP action protocol is trivial — POST `{ action, params }` to
// the endpoint, read back the JSON envelope — so the MCP talks to it directly
// with `fetch`. We deliberately do NOT depend on @snowluma/sdk here: its
// published dist is bundler-targeted ESM (extensionless relative imports) that
// native `node` cannot resolve without a bundler, and this package is a plain
// `tsc`-built stdio bin. The wire shape — not a shared client type — is the seam
// (ADR-0005); tests inject a fake `ActionClient` (or a fake `fetch`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STREAM_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_STREAM_DIR = path.join(os.tmpdir(), 'onebot-mcp-downloads');
const MAX_GENERIC_FRAMES = 256;
const MAX_GENERIC_TEXT_BYTES = 256 * 1024;
// OneBot permits a 16 MiB decoded download chunk. Base64 expands that to
// ~21.34 MiB; 24 MiB leaves room for the JSON envelope without allowing an
// unterminated peer to grow our parser buffer without bound.
const MAX_WIRE_FRAME_BYTES = 24 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 512 * 1024;
const MAX_FILE_CHUNKS = 200_000;
const RESET_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_STREAMS = 4;
const INTERNAL_STREAM_CALL = Symbol('snowluma.mcp.internalStreamCall');
const MCP_UPLOAD_OWNED_FIELDS = [
  'stream_id', 'chunk_data', 'chunk_index', 'total_chunks', 'file_size',
  'expected_sha256', 'is_complete', 'reset', 'verify_only',
] as const;
const FILE_DOWNLOAD_ACTIONS = new Set([
  'download_file_stream',
  'download_file_image_stream',
  'download_file_record_stream',
]);

export function parseMaxStreamBytes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`SNOWLUMA_MCP_MAX_STREAM_BYTES must be an integer between 1 and ${DEFAULT_MAX_STREAM_BYTES}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > DEFAULT_MAX_STREAM_BYTES) {
    throw new Error(`SNOWLUMA_MCP_MAX_STREAM_BYTES must be an integer between 1 and ${DEFAULT_MAX_STREAM_BYTES}`);
  }
  return parsed;
}

export function parseTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('SNOWLUMA_MCP_TIMEOUT_MS must be a positive integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new Error('SNOWLUMA_MCP_TIMEOUT_MS must be a positive integer no greater than 2147483647');
  }
  return parsed;
}

/** OneBot v11 response envelope, passed through to the LLM verbatim. */
export interface OneBotEnvelope {
  status: string;
  retcode: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: unknown;
  [k: string]: unknown;
}

export interface ActionClient {
  /** Send one OneBot action; resolves the full envelope (even on retcode≠0),
   *  rejects only on transport-level failure (timeout / connection / bad body). */
  call(action: string, params: Record<string, unknown>): Promise<OneBotEnvelope>;
  /** Execute a Stream Action over the HTTP multi-frame transport. */
  callStream(action: string, params: Record<string, unknown>, options?: StreamCallOptions): Promise<StreamCallResult>;
}

export interface StreamCallOptions {
  /** MCP-host file to upload. Only valid for upload_file_stream. */
  inputFile?: string;
  /** Cancellation from the originating MCP request. */
  signal?: AbortSignal;
}

type InternalStreamCallOptions = StreamCallOptions & { [INTERNAL_STREAM_CALL]?: true };

interface DownloadReservation {
  streamDir: string;
  partPath: string;
  finalPath: string;
  bytes: number;
}

// Process-wide because multiple MCP clients can target the same directory.
const downloadReservations = new Map<string, Map<string, DownloadReservation>>();

function reserveDownloadQuota(
  streamDir: string,
  partPath: string,
  finalPath: string,
  bytes: number,
  quotaBytes: number,
): DownloadReservation {
  const active = downloadReservations.get(streamDir) ?? new Map<string, DownloadReservation>();
  const activePaths = new Set<string>();
  let reservedBytes = 0;
  for (const reservation of active.values()) {
    activePaths.add(reservation.partPath);
    activePaths.add(reservation.finalPath);
    reservedBytes += reservation.bytes;
  }
  let existingBytes = 0;
  for (const entry of fs.readdirSync(streamDir, { withFileTypes: true })) {
    const target = path.join(streamDir, entry.name);
    if (activePaths.has(target) || !entry.isFile()) continue;
    try {
      existingBytes += fs.lstatSync(target).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (existingBytes + reservedBytes + bytes > quotaBytes) {
    throw new Error(
      `download directory quota ${quotaBytes} bytes exceeded: existing=${existingBytes}, reserved=${reservedBytes}, requested reserve=${bytes}`,
    );
  }
  const reservation = { streamDir, partPath, finalPath, bytes };
  active.set(partPath, reservation);
  downloadReservations.set(streamDir, active);
  return reservation;
}

function releaseDownloadQuota(reservation: DownloadReservation | undefined): void {
  if (!reservation) return;
  const active = downloadReservations.get(reservation.streamDir);
  if (!active) return;
  active.delete(reservation.partPath);
  if (active.size === 0) downloadReservations.delete(reservation.streamDir);
}

function validateStreamDirectory(streamDir: string): void {
  try {
    fs.accessSync(
      streamDir,
      fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK,
    );
    // Quota admission scans the directory before opening a partial file, so
    // list access is a startup requirement too.
    fs.readdirSync(streamDir);
  } catch (error) {
    throw new Error(`streamDir is not readable, writable, and traversable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const probePath = path.join(streamDir, `.snowluma-mcp-write-probe-${randomUUID()}`);
  let probeFd: number | undefined;
  const cleanupErrors: string[] = [];
  try {
    probeFd = fs.openSync(probePath, 'wx', 0o600);
  } catch (error) {
    throw new Error(`streamDir cannot create files: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    fs.closeSync(probeFd);
    probeFd = undefined;
  } catch (error) {
    cleanupErrors.push(`close probe: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    fs.unlinkSync(probePath);
  } catch (error) {
    cleanupErrors.push(`remove probe: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (cleanupErrors.length > 0) {
    throw new Error(`streamDir write probe cleanup failed: ${cleanupErrors.join('; ')}`);
  }
}

export interface GenericStreamResult {
  frame_count: number;
  /** Intermediate frames only. Kept bounded by the HTTP client. */
  frames: OneBotEnvelope[];
  /** Last frame received. upload_file_stream acknowledgements are single-frame responses. */
  terminal: OneBotEnvelope;
}

export interface FileStreamResult {
  file_path: string;
  file_size: number;
  sha256: string;
  frame_count: number;
  terminal: OneBotEnvelope;
}

export interface UploadStreamResult {
  file_path: string;
  file_size: number;
  sha256: string;
  chunk_count: number;
  stream_id: string;
  terminal: OneBotEnvelope;
}

export type StreamCallResult = GenericStreamResult | FileStreamResult | UploadStreamResult;

export interface HttpClientOptions {
  /** OneBot HTTP endpoint, e.g. http://127.0.0.1:3000/. */
  endpoint: string;
  accessToken?: string;
  timeoutMs?: number;
  /** Directory on the MCP host where downloaded Stream Actions are committed. */
  streamDir?: string;
  /** Per-file cap. Defaults to OneBot's 4 GiB limit. */
  maxStreamBytes?: number;
  /** Existing MCP-host directory from which automatic uploads may read. */
  uploadRoot?: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function safeDownloadName(value: unknown): string {
  const raw = typeof value === 'string' ? path.basename(value) : 'download.bin';
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 180);
  return safe || 'download.bin';
}

function decodeBase64Chunk(value: string): Buffer {
  const valid = value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  if (!valid) throw new Error('file_chunk.data is not valid canonical base64');
  return Buffer.from(value, 'base64');
}

async function writeAll(handle: fs.promises.FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write(data, offset, data.length - offset);
    if (bytesWritten <= 0) throw new Error('file write made no progress');
    offset += bytesWritten;
  }
}

function terminalData(result: StreamCallResult): Record<string, unknown> | undefined {
  return record(result.terminal.data);
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  return reason instanceof Error ? reason.message : reason === undefined ? 'aborted' : String(reason);
}

function throwIfCancelled(signal: AbortSignal | undefined, action: string, stage: string): void {
  if (signal?.aborted) {
    throw new Error(`action ${action} stream ${stage}: cancelled: ${abortReason(signal)}`);
  }
}

type ByteStreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  action: string,
  frameIndex: number,
): Promise<ByteStreamReadResult> {
  if (callerSignal?.aborted) {
    throw new Error(`action ${action} stream read frame ${frameIndex}: cancelled: ${abortReason(callerSignal)}`);
  }
  return new Promise<ByteStreamReadResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => finish(() => reject(new Error(
      `action ${action} stream read frame ${frameIndex}: cancelled: ${callerSignal ? abortReason(callerSignal) : 'aborted'}`,
    )));
    const timer = setTimeout(() => finish(() => reject(new Error(
      `action ${action} stream read frame ${frameIndex}: idle timeout after ${timeoutMs}ms`,
    ))), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function uploadLocalFile(
  action: string,
  inputFile: string,
  params: Record<string, unknown>,
  maxStreamBytes: number,
  callerSignal: AbortSignal | undefined,
  post: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<StreamCallResult>,
): Promise<UploadStreamResult> {
  const streamId = randomUUID();
  let handle: fs.promises.FileHandle | undefined;
  let stage = 'open input';
  let remoteTouched = false;
  try {
    throwIfCancelled(callerSignal, action, stage);
    handle = await fs.promises.open(
      inputFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    throwIfCancelled(callerSignal, action, stage);
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error('input_file is not a regular file');
    if (initial.size > maxStreamBytes) throw new Error(`input_file exceeds limit (${maxStreamBytes} bytes)`);

    const totalChunks = Math.max(1, Math.ceil(initial.size / UPLOAD_CHUNK_BYTES));
    const baseParams = { ...params };
    for (const key of MCP_UPLOAD_OWNED_FIELDS) {
      delete baseParams[key];
    }
    const filename = typeof params.filename === 'string' && params.filename ? params.filename : path.basename(inputFile);
    const hash = createHash('sha256');
    let bytesRead = 0;

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      stage = `read chunk ${chunkIndex}`;
      throwIfCancelled(callerSignal, action, stage);
      const wanted = initial.size === 0 ? 0 : Math.min(UPLOAD_CHUNK_BYTES, initial.size - bytesRead);
      const chunk = Buffer.allocUnsafe(wanted);
      let filled = 0;
      while (filled < wanted) {
        const read = await handle.read(chunk, filled, wanted - filled, bytesRead + filled);
        if (read.bytesRead === 0) break;
        filled += read.bytesRead;
      }
      if (filled !== wanted) throw new Error(`input_file changed while reading (expected ${wanted} bytes, read ${filled})`);
      throwIfCancelled(callerSignal, action, stage);
      const payload = filled === chunk.length ? chunk : chunk.subarray(0, filled);
      hash.update(payload);
      bytesRead += payload.length;

      stage = `send chunk ${chunkIndex}`;
      throwIfCancelled(callerSignal, action, stage);
      remoteTouched = true;
      const ack = await post({
        ...baseParams,
        stream_id: streamId,
        chunk_data: payload.toString('base64'),
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        file_size: initial.size,
        filename,
      }, callerSignal);
      throwIfCancelled(callerSignal, action, stage);
      const ackData = terminalData(ack);
      if (ackData?.type !== 'stream' || ackData.status !== 'chunk_received') {
        throw new Error(`unexpected chunk acknowledgement: ${JSON.stringify(ack.terminal)}`);
      }
    }

    stage = 'verify input';
    throwIfCancelled(callerSignal, action, stage);
    const afterRead = await handle.stat();
    throwIfCancelled(callerSignal, action, stage);
    if (afterRead.size !== initial.size || afterRead.mtimeMs !== initial.mtimeMs) {
      throw new Error('input_file changed during upload');
    }
    if (bytesRead !== initial.size) throw new Error(`input_file size mismatch (expected ${initial.size}, read ${bytesRead})`);
    const sha256 = hash.digest('hex');

    stage = 'close input';
    await handle.close();
    handle = undefined;

    stage = 'complete upload';
    throwIfCancelled(callerSignal, action, stage);
    const completed = await post({
      ...baseParams,
      stream_id: streamId,
      total_chunks: totalChunks,
      file_size: initial.size,
      expected_sha256: sha256,
      is_complete: true,
      filename,
    }, callerSignal);
    throwIfCancelled(callerSignal, action, stage);
    const data = terminalData(completed);
    if (data?.type !== 'response' || data.status !== 'file_complete') {
      throw new Error(`unexpected completion acknowledgement: ${JSON.stringify(completed.terminal)}`);
    }
    if (data.file_size !== initial.size) throw new Error(`remote file_size mismatch (expected ${initial.size}, got ${String(data.file_size)})`);
    if (data.sha256 !== sha256) throw new Error(`remote sha256 mismatch (expected ${sha256}, got ${String(data.sha256)})`);
    if (typeof data.file_path !== 'string' || !data.file_path) throw new Error('completion acknowledgement has no file_path');

    return {
      file_path: data.file_path,
      file_size: initial.size,
      sha256,
      chunk_count: totalChunks,
      stream_id: streamId,
      terminal: completed.terminal,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    let closeFailure = '';
    if (handle) {
      try {
        await handle.close();
        handle = undefined;
      } catch (closeError) {
        closeFailure = `; close input failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`;
      }
    }
    let resetFailure = '';
    if (remoteTouched) {
      try {
        await post({ stream_id: streamId, reset: true }, AbortSignal.timeout(RESET_TIMEOUT_MS));
      } catch (resetError) {
        resetFailure = `; remote reset failed: ${resetError instanceof Error ? resetError.message : String(resetError)}`;
      }
    }
    throw new Error(`action ${action} stream ${stage}: ${detail}${closeFailure}${resetFailure}`);
  }
}

export function makeHttpClient(opts: HttpClientOptions): ActionClient {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('timeoutMs must be a positive integer no greater than 2147483647');
  }
  const maxStreamBytes = opts.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes <= 0 || maxStreamBytes > DEFAULT_MAX_STREAM_BYTES) {
    throw new Error(`maxStreamBytes must be an integer between 1 and ${DEFAULT_MAX_STREAM_BYTES}`);
  }
  const configuredStreamDir = path.resolve(opts.streamDir ?? DEFAULT_STREAM_DIR);
  try {
    fs.mkdirSync(configuredStreamDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`streamDir cannot be created: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!fs.statSync(configuredStreamDir).isDirectory()) {
    throw new Error(`streamDir is not a directory: ${configuredStreamDir}`);
  }
  const streamDir = fs.realpathSync(configuredStreamDir);
  validateStreamDirectory(streamDir);
  let uploadRoot: string | undefined;
  if (opts.uploadRoot) {
    uploadRoot = fs.realpathSync(opts.uploadRoot);
    if (!fs.statSync(uploadRoot).isDirectory()) throw new Error(`uploadRoot is not a directory: ${uploadRoot}`);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;

  let client: ActionClient;
  let activeStreams = 0;
  client = {
    async call(action, params) {
      let res: Response;
      try {
        res = await fetchImpl(opts.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new Error(`action ${action} request: ${error instanceof Error ? error.message : String(error)}`);
      }
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`OneBot returned non-JSON (HTTP ${res.status})`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`OneBot returned an unexpected response (HTTP ${res.status})`);
      }
      return parsed as OneBotEnvelope;
    },
    async callStream(action, params, options) {
      const internalOptions = options as InternalStreamCallOptions | undefined;
      const ownsSlot = internalOptions?.[INTERNAL_STREAM_CALL] !== true;
      if (ownsSlot) {
        if (activeStreams >= MAX_ACTIVE_STREAMS) {
          throw new Error(`action ${action} stream admission: active Stream Action limit reached (${MAX_ACTIVE_STREAMS})`);
        }
        activeStreams++;
      }
      try {
        let resolvedInputFile: string | undefined;
        if (options?.inputFile) {
          if (action !== 'upload_file_stream') {
            throw new Error(`action ${action} stream resolve input: input_file is only valid for upload_file_stream`);
          }
          if (!uploadRoot) {
            throw new Error(`action ${action} stream resolve input: SNOWLUMA_MCP_UPLOAD_ROOT is not configured`);
          }
          const conflicts = MCP_UPLOAD_OWNED_FIELDS.filter((key) => Object.hasOwn(params, key));
          if (conflicts.length) {
            throw new Error(`action ${action} stream prepare upload: params conflict with MCP-owned transfer fields: ${conflicts.join(', ')}`);
          }
          try {
            resolvedInputFile = fs.realpathSync(options.inputFile);
          } catch (error) {
            throw new Error(`action ${action} stream resolve input: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (!isWithin(uploadRoot, resolvedInputFile)) {
            throw new Error(`action ${action} stream resolve input: resolved path is outside the configured upload root`);
          }
          return uploadLocalFile(
            action,
            resolvedInputFile,
            params,
            maxStreamBytes,
            options.signal,
            (uploadParams, signal) => client.callStream(action, uploadParams, {
              ...(signal ? { signal } : {}),
              [INTERNAL_STREAM_CALL]: true,
            } as InternalStreamCallOptions),
          );
        }
        let res: Response;
        const connectionController = new AbortController();
        const requestSignal = options?.signal
          ? AbortSignal.any([options.signal, connectionController.signal])
          : connectionController.signal;
        const connectionTimer = setTimeout(() => {
          connectionController.abort(new Error(`connection timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof connectionTimer.unref === 'function') connectionTimer.unref();
        try {
          res = await fetchImpl(opts.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action, params }),
            signal: requestSignal,
          });
        } catch (error) {
          const detail = options?.signal?.aborted
            ? `cancelled: ${abortReason(options.signal)}`
            : connectionController.signal.aborted
              ? abortReason(connectionController.signal)
              : error instanceof Error ? error.message : String(error);
          throw new Error(`action ${action} stream connection: ${detail}`);
        } finally {
          clearTimeout(connectionTimer);
        }
        if (!res.ok) throw new Error(`action ${action} stream HTTP: unexpected status ${res.status}`);
        if (!res.body) throw new Error(`action ${action} stream body: response body is unavailable`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const frames: OneBotEnvelope[] = [];
        let buffer = '';
        let bufferWireBytes = 0;
        let frameIndex = 0;
        let fileHandle: fs.promises.FileHandle | undefined;
        let partPath: string | undefined;
        let finalPath: string | undefined;
        let declaredSize: number | undefined;
        let fileBytes = 0;
        let fileChunks = 0;
        let fileTerminal: OneBotEnvelope | undefined;
        let quotaReservation: DownloadReservation | undefined;
        let genericTextBytes = 0;
        let genericTerminalIndex: number | undefined;
        const fileHash = createHash('sha256');

        const acceptFrame = async (frame: OneBotEnvelope, rawBytes: number): Promise<void> => {
          const data = record(frame.data);
          const dataType = data?.data_type;
          const resetAck = action === 'upload_file_stream' && params.reset === true &&
          /stream reset completed/i.test(String(frame.wording ?? frame.message ?? ''));
          if (!resetAck && (frame.status !== 'ok' || frame.retcode !== 0 || data?.type === 'error')) {
            const detail = frame.wording || frame.message || `retcode=${String(frame.retcode)}`;
            throw new Error(`action ${action} stream frame ${frameIndex}: terminal error: ${detail}`);
          }
          if (frameIndex === 0 && FILE_DOWNLOAD_ACTIONS.has(action) && dataType !== 'file_info') {
            throw new Error(`action ${action} stream frame 0: first successful frame must be file_info`);
          }
          if (!fileHandle && (dataType === 'file_chunk' || dataType === 'file_complete')) {
            throw new Error(`action ${action} stream frame ${frameIndex}: ${String(dataType)} received without file_info`);
          }
          if (dataType === 'file_info') {
            if (!data) throw new Error(`action ${action} stream frame ${frameIndex}: file_info data must be an object`);
            if (frameIndex !== 0 || fileHandle) throw new Error(`action ${action} stream frame ${frameIndex}: file_info must be the first and only header`);
            const size = data.file_size;
            if (!Number.isSafeInteger(size) || (size as number) < 0) {
              throw new Error(`action ${action} stream frame ${frameIndex}: invalid file_size`);
            }
            if ((size as number) > maxStreamBytes) {
              throw new Error(`action ${action} stream frame ${frameIndex}: file_size exceeds limit (${maxStreamBytes} bytes)`);
            }
            if (data.chunk_size !== undefined) {
              if (!Number.isSafeInteger(data.chunk_size) || (data.chunk_size as number) <= 0) {
                throw new Error(`action ${action} stream frame ${frameIndex}: invalid chunk_size`);
              }
              const expectedChunks = Math.ceil((size as number) / (data.chunk_size as number));
              if (expectedChunks > MAX_FILE_CHUNKS) {
                throw new Error(`action ${action} stream frame ${frameIndex}: declared file chunks exceed limit (${MAX_FILE_CHUNKS})`);
              }
            }
            // NapCat/SnowLuma use 0 when the source length is unknown. Only a
            // positive header value is a strict declaration.
            declaredSize = (size as number) > 0 ? size as number : undefined;
            const filename = `${randomUUID()}-${safeDownloadName(data.file_name)}`;
            finalPath = path.join(streamDir, filename);
            partPath = `${finalPath}.part`;
            quotaReservation = reserveDownloadQuota(
              streamDir,
              partPath,
              finalPath,
              declaredSize ?? maxStreamBytes,
              2 * maxStreamBytes,
            );
            try {
              fileHandle = await fs.promises.open(partPath, 'wx', 0o600);
            } catch (error) {
              releaseDownloadQuota(quotaReservation);
              quotaReservation = undefined;
              throw error;
            }
            return;
          }

          if (fileHandle) {
            if (fileTerminal) throw new Error(`action ${action} stream frame ${frameIndex}: frame received after terminal`);
            if (dataType === 'file_chunk') {
              if (fileChunks >= MAX_FILE_CHUNKS) {
                throw new Error(`action ${action} stream frame ${frameIndex}: file chunks exceed limit (${MAX_FILE_CHUNKS})`);
              }
              if (!data || typeof data.data !== 'string') throw new Error(`action ${action} stream frame ${frameIndex}: file_chunk.data must be base64 text`);
              if (!Number.isSafeInteger(data.index) || data.index !== fileChunks) {
                throw new Error(`action ${action} stream frame ${frameIndex}: expected chunk index ${fileChunks}, got ${String(data.index)}`);
              }
              let chunk: Buffer;
              try {
                chunk = decodeBase64Chunk(data.data);
              } catch (error) {
                throw new Error(`action ${action} stream frame ${frameIndex}: ${error instanceof Error ? error.message : String(error)}`);
              }
              if (data.size !== undefined && (!Number.isSafeInteger(data.size) || data.size !== chunk.length)) {
                throw new Error(`action ${action} stream frame ${frameIndex}: file_chunk.size does not match decoded base64 bytes`);
              }
              const nextBytes = fileBytes + chunk.length;
              if (declaredSize !== undefined && nextBytes > declaredSize) {
                throw new Error(`action ${action} stream frame ${frameIndex}: downloaded bytes exceed declared file_size (${declaredSize} bytes)`);
              }
              if (nextBytes > maxStreamBytes) {
                throw new Error(`action ${action} stream frame ${frameIndex}: downloaded bytes exceed limit (${maxStreamBytes} bytes)`);
              }
              await writeAll(fileHandle, chunk);
              fileHash.update(chunk);
              fileBytes += chunk.length;
              fileChunks++;
              return;
            }
            if (data?.type === 'response' && dataType === 'file_complete') {
              fileTerminal = frame;
              return;
            }
            throw new Error(`action ${action} stream frame ${frameIndex}: unexpected file frame ${String(dataType ?? data?.type ?? 'unknown')}`);
          }

          if (frames.length >= MAX_GENERIC_FRAMES) {
            throw new Error(`action ${action} stream frame ${frameIndex}: generic frame summary exceeds limit (${MAX_GENERIC_FRAMES})`);
          }
          if (genericTerminalIndex !== undefined) {
            throw new Error(`action ${action} stream frame ${frameIndex}: frame received after response terminal at frame ${genericTerminalIndex}`);
          }
          genericTextBytes += rawBytes;
          if (genericTextBytes > MAX_GENERIC_TEXT_BYTES) {
            throw new Error(`action ${action} stream frame ${frameIndex}: generic summary text exceeds limit (${MAX_GENERIC_TEXT_BYTES} bytes)`);
          }
          frames.push(frame);
          if (data?.type === 'response') genericTerminalIndex = frameIndex;
        };
        try {
          while (true) {
            const { done, value } = await readWithIdleTimeout(reader, timeoutMs, options?.signal, action, frameIndex);
            if (done) break;
            bufferWireBytes += value.byteLength;
            buffer += decoder.decode(value, { stream: true });
            let delimiter: number;
            while ((delimiter = buffer.indexOf('\r\n\r\n')) >= 0) {
              const raw = buffer.slice(0, delimiter);
              buffer = buffer.slice(delimiter + 4);
              const rawBytes = Buffer.byteLength(raw, 'utf8');
              bufferWireBytes -= rawBytes + 4;
              if (rawBytes > MAX_WIRE_FRAME_BYTES) {
                throw new Error(`action ${action} stream frame ${frameIndex}: wire frame exceeds limit (${MAX_WIRE_FRAME_BYTES} bytes)`);
              }
              if (!raw) throw new Error(`action ${action} stream frame ${frameIndex}: empty frame`);
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch (error) {
                throw new Error(`action ${action} stream frame ${frameIndex}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
              }
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error(`action ${action} stream frame ${frameIndex}: expected an object envelope`);
              }
              try {
                await acceptFrame(parsed as OneBotEnvelope, rawBytes);
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                if (detail.startsWith(`action ${action} `)) throw error;
                throw new Error(`action ${action} stream frame ${frameIndex}: frame handling failed: ${detail}`);
              }
              frameIndex++;
            }
            if (bufferWireBytes > MAX_WIRE_FRAME_BYTES) {
              throw new Error(`action ${action} stream frame ${frameIndex}: wire frame exceeds limit (${MAX_WIRE_FRAME_BYTES} bytes)`);
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) throw new Error(`action ${action} stream EOF after frame ${frameIndex}: unterminated frame`);
          if (fileHandle) {
            if (!fileTerminal) throw new Error(`action ${action} stream EOF after frame ${frameIndex}: missing file_complete terminal`);
            if (declaredSize !== undefined && declaredSize !== fileBytes) {
              throw new Error(`action ${action} stream EOF after frame ${frameIndex}: expected ${declaredSize} bytes, received ${fileBytes}`);
            }
            const terminalData = record(fileTerminal.data);
            if (!Number.isSafeInteger(terminalData?.total_bytes) || (terminalData!.total_bytes as number) < 0) {
              throw new Error(`action ${action} stream EOF after frame ${frameIndex}: terminal total_bytes is missing or invalid`);
            }
            if (terminalData!.total_bytes !== fileBytes) {
              throw new Error(`action ${action} stream EOF after frame ${frameIndex}: terminal total_bytes mismatch`);
            }
            if (terminalData?.total_chunks !== undefined && terminalData.total_chunks !== fileChunks) {
              throw new Error(`action ${action} stream EOF after frame ${frameIndex}: terminal total_chunks mismatch`);
            }
            const sha256 = fileHash.digest('hex');
            await fileHandle.close();
            fileHandle = undefined;
            await fs.promises.rename(partPath!, finalPath!);
            partPath = undefined;
            releaseDownloadQuota(quotaReservation);
            quotaReservation = undefined;
            return {
              file_path: finalPath!,
              file_size: fileBytes,
              sha256,
              frame_count: frameIndex,
              terminal: fileTerminal,
            };
          }
          if (!frames.length) throw new Error(`action ${action} stream EOF: no frames received`);
          const uploadAck = action === 'upload_file_stream' && frames.length === 1;
          if (genericTerminalIndex === undefined && !uploadAck) {
            throw new Error(`action ${action} stream EOF after frame ${frameIndex}: missing response terminal`);
          }
          return { frame_count: frames.length, frames: frames.slice(0, -1), terminal: frames.at(-1)! };
        } catch (error) {
          const cleanupErrors: string[] = [];
          try { await reader.cancel(error instanceof Error ? error.message : String(error)); } catch (cleanupError) {
            cleanupErrors.push(`cancel response body: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
          try { await fileHandle?.close(); } catch (cleanupError) {
            cleanupErrors.push(`close: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
          }
          if (partPath) {
            try { await fs.promises.rm(partPath, { force: true }); } catch (cleanupError) {
              cleanupErrors.push(`remove ${partPath}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
            }
          }
          releaseDownloadQuota(quotaReservation);
          quotaReservation = undefined;
          const detail = error instanceof Error ? error.message : String(error);
          const base = detail.startsWith(`action ${action} `) ? detail : `action ${action} stream body: ${detail}`;
          const suffix = cleanupErrors.length ? `; cleanup failed (${cleanupErrors.join('; ')})` : '';
          throw new Error(base + suffix);
        } finally {
          reader.releaseLock();
        }
      } finally {
        if (ownsSlot) activeStreams--;
      }
    },
  };
  return client;
}
