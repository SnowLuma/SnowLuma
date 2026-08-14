// createFlashTask stages each source to disk and streams hash + sliceupload
// (#359). OIDB / sliceupload HTTP are mocked; the file bytes and Sha1StateV
// on the wire must still match the buffered flash helpers.

import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { FlashSliceUploadBody, FlashSliceUploadResp } from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { ApplyFileset } from '@snowluma/protocol/oidb-services/flash-transfer/apply-fileset';
import { CommitFile } from '@snowluma/protocol/oidb-services/flash-transfer/commit-file';
import { CompleteFileset } from '@snowluma/protocol/oidb-services/flash-transfer/complete-fileset';
import { PrepareUpload } from '@snowluma/protocol/oidb-services/flash-transfer/prepare-upload';
import { ApplyUpload } from '@snowluma/protocol/oidb-services/flash-transfer/apply-upload';
import { SetFilesetStatus } from '@snowluma/protocol/oidb-services/flash-transfer/set-status';
import { computeSha1StateV } from '@snowluma/protocol/highway/sha1-stream';
import {
  computeHashes,
  FLASH_TRANSFER_INLINE_MAX_BYTES,
  FLASH_TRANSFER_MAX_BYTES,
} from '@snowluma/protocol/highway/utils';
import * as stageMod from '@snowluma/protocol/highway/stage';
import * as hashMod from '@snowluma/protocol/highway/hash-file';
import { FlashTransferApi } from '../src/bridge/apis/flash-transfer';
import { mockBridge } from './actions/_helpers';

const FILESET = '8e40afa1-829d-498b-852f-092394ddb31f';
const SLICE_URL = 'https://multimedia.qfile.qq.com/sliceupload';
const SLICE = 1024 * 1024;
const originalFetch = globalThis.fetch;

let dir: string;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-flash-create-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function writeSrc(name: string, bytes: Uint8Array): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function synth(size: number, seed = 7): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 131 + seed) & 0xff;
  return b;
}

function toU8(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  throw new Error(`unexpected fetch body: ${typeof body}`);
}

function installSliceuploadOk(): FlashSliceUploadBody[] {
  const calls: FlashSliceUploadBody[] = [];
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input);
    if (url !== SLICE_URL) throw new Error(`unexpected fetch ${url}`);
    calls.push(protobuf_decode<FlashSliceUploadBody>(toU8(init?.body)));
    return new Response(
      Buffer.from(protobuf_encode<FlashSliceUploadResp>({ status: 'success' })),
      { status: 200 },
    );
  }) as typeof fetch;
  return calls;
}

function mainSlices(calls: FlashSliceUploadBody[]): FlashSliceUploadBody[] {
  return calls.filter((c) => c.appid === 14901);
}

function stubOidb(): void {
  vi.spyOn(ApplyFileset, 'invoke').mockResolvedValue({ filesetUuid: FILESET });
  vi.spyOn(CommitFile, 'invoke').mockResolvedValue({});
  vi.spyOn(CompleteFileset, 'invoke').mockResolvedValue(undefined);
  vi.spyOn(PrepareUpload, 'invoke').mockResolvedValue('rkey-main');
  vi.spyOn(ApplyUpload, 'invoke').mockResolvedValue(undefined);
  vi.spyOn(SetFilesetStatus, 'invoke').mockResolvedValue(undefined);
}

function api(): FlashTransferApi {
  return new FlashTransferApi(mockBridge() as never);
}

describe('FlashTransferApi.createFlashTask — disk streaming (#359)', () => {
  beforeEach(() => {
    stubOidb();
  });

  it('stages a local file, commits metadata, and sliceuploads the disk bytes with flash Sha1StateV', async () => {
    const bytes = synth(200);
    const file = writeSrc('clip.mp4', bytes);
    const hashes = computeHashes(bytes);
    const sha1StateV = computeSha1StateV(bytes, 1, SLICE);
    const stageSpy = vi.spyOn(stageMod, 'stageSourceToDisk');
    const slices = installSliceuploadOk();

    await expect(api().createFlashTask(file)).resolves.toEqual({ filesetId: FILESET });

    expect(stageSpy).toHaveBeenCalledWith(file, FLASH_TRANSFER_MAX_BYTES);
    expect(ApplyFileset.invoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fileName: 'clip.mp4',
      origName: 'clip.mp4',
      fileSize: 200,
      typeCode: 7,
      uploader: { uin: '10001', nickname: 'self-nick', uid: 'self-uid' },
    }));
    expect(CommitFile.invoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      filesetUuid: FILESET,
      entries: [expect.objectContaining({
        fileName: 'clip.mp4',
        fileSize: 200,
        fileIndex: 1,
        formatCode: 2,
      })],
    }));
    expect(CompleteFileset.invoke).toHaveBeenCalledWith(expect.anything(), { filesetUuid: FILESET });

    const uploaded = mainSlices(slices);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.payload?.rkey).toBe('rkey-main');
    expect(uploaded[0]!.payload?.start).toBe(0);
    expect(uploaded[0]!.payload?.end).toBe(199);
    expect(Buffer.from(uploaded[0]!.payload!.chunk!).equals(Buffer.from(bytes))).toBe(true);
    expect(Buffer.from(uploaded[0]!.payload!.sha1!).equals(
      createHash('sha1').update(Buffer.from(bytes)).digest(),
    )).toBe(true);
    expect(uploaded[0]!.payload!.sha1StateV!.state).toHaveLength(1);
    expect(Buffer.from(uploaded[0]!.payload!.sha1StateV!.state![0]!).equals(Buffer.from(sha1StateV[0]!))).toBe(true);
    expect(Buffer.from(uploaded[0]!.payload!.sha1StateV!.state![0]!).equals(Buffer.from(hashes.sha1))).toBe(true);

    expect(SetFilesetStatus.invoke).toHaveBeenCalledWith(expect.anything(), { filesetUuid: FILESET });
  });

  it('caps inline base64 at the RAM-decode ceiling, not the 4 GiB disk ceiling', async () => {
    const bytes = synth(32, 9);
    const source = `base64://${Buffer.from(bytes).toString('base64')}`;
    const stageSpy = vi.spyOn(stageMod, 'stageSourceToDisk');
    installSliceuploadOk();

    await api().createFlashTask(source);
    expect(stageSpy).toHaveBeenCalledWith(source, FLASH_TRANSFER_INLINE_MAX_BYTES);
  });

  it('rejects an empty file before applying a fileset and still releases the stage', async () => {
    const file = writeSrc('empty.bin', new Uint8Array(0));
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const actualStage = stageMod.stageSourceToDisk;
    vi.spyOn(stageMod, 'stageSourceToDisk').mockImplementation(async (source, maxBytes) => {
      const staged = await actualStage(source, maxBytes);
      const cleanup = vi.fn(async () => staged.cleanup());
      cleanups.push(cleanup);
      return { ...staged, cleanup };
    });

    await expect(api().createFlashTask(file)).rejects.toThrow(/empty/i);
    expect(ApplyFileset.invoke).not.toHaveBeenCalled();
    expect(cleanups[0]).toHaveBeenCalled();
  });

  it('releases staged temps when apply-fileset fails', async () => {
    const file = writeSrc('fail.mp4', synth(40, 3));
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const actualStage = stageMod.stageSourceToDisk;
    vi.spyOn(stageMod, 'stageSourceToDisk').mockImplementation(async (source, maxBytes) => {
      const staged = await actualStage(source, maxBytes);
      const cleanup = vi.fn(async () => staged.cleanup());
      cleanups.push(cleanup);
      return { ...staged, cleanup };
    });
    vi.mocked(ApplyFileset.invoke).mockRejectedValueOnce(new Error('oidb down'));

    await expect(api().createFlashTask(file)).rejects.toThrow('oidb down');
    expect(cleanups[0]).toHaveBeenCalled();
  });

  it('skips sliceupload when prepare-upload reports a seconds-pass', async () => {
    const file = writeSrc('hit.mp4', synth(80, 11));
    vi.mocked(PrepareUpload.invoke).mockImplementation(async (_ctx, p) => (
      p.thumbType ? 'thumb-rkey' : null
    ));
    const slices = installSliceuploadOk();

    await api().createFlashTask(file);
    expect(mainSlices(slices)).toHaveLength(0);
    expect(ApplyUpload.invoke).toHaveBeenCalled(); // thumbs still apply
    expect(SetFilesetStatus.invoke).toHaveBeenCalled();
  });

  it('sliceuploads a multi-megabyte file as 1 MiB disk chunks with flash Sha1StateV', async () => {
    const bytes = synth(SLICE + 80, 13);
    const file = writeSrc('big.mp4', bytes);
    const sha1StateV = computeSha1StateV(bytes, 2, SLICE);
    const slices = installSliceuploadOk();

    await api().createFlashTask(file);

    const uploaded = mainSlices(slices);
    expect(uploaded).toHaveLength(2);
    expect(uploaded[0]!.payload?.start).toBe(0);
    expect(uploaded[0]!.payload?.end).toBe(SLICE - 1);
    expect(uploaded[1]!.payload?.start).toBe(SLICE);
    expect(uploaded[1]!.payload?.end).toBe(SLICE + 79);
    expect(Buffer.from(uploaded[0]!.payload!.chunk!).equals(Buffer.from(bytes.subarray(0, SLICE)))).toBe(true);
    expect(Buffer.from(uploaded[1]!.payload!.chunk!).equals(Buffer.from(bytes.subarray(SLICE)))).toBe(true);
    expect(uploaded[0]!.payload!.sha1StateV!.state).toHaveLength(2);
    expect(Buffer.from(uploaded[0]!.payload!.sha1StateV!.state![0]!).equals(Buffer.from(sha1StateV[0]!))).toBe(true);
    expect(Buffer.from(uploaded[0]!.payload!.sha1StateV!.state![1]!).equals(Buffer.from(sha1StateV[1]!))).toBe(true);
    expect(Buffer.from(uploaded[1]!.payload!.sha1StateV!.state![1]!).equals(
      createHash('sha1').update(Buffer.from(bytes)).digest(),
    )).toBe(true);
  });

  it('commits every fileset entry once, then sliceuploads each file from disk', async () => {
    const a = synth(50, 1);
    const b = synth(70, 2);
    const fileA = writeSrc('a.mp4', a);
    const fileB = writeSrc('b.zip', b);
    const slices = installSliceuploadOk();

    await api().createFlashTask([fileA, fileB]);

    expect(ApplyFileset.invoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fileName: 'a.mp4等2个文件',
      fileSize: 120,
    }));
    const commit = vi.mocked(CommitFile.invoke).mock.calls[0]![1];
    expect(commit.entries).toHaveLength(2);
    expect(commit.entries[0]).toEqual(expect.objectContaining({
      fileName: 'a.mp4', fileSize: 50, fileIndex: 1, formatCode: 2,
    }));
    expect(commit.entries[1]).toEqual(expect.objectContaining({
      fileName: 'b.zip', fileSize: 70, fileIndex: 2, formatCode: 4,
    }));

    const uploaded = mainSlices(slices);
    expect(uploaded).toHaveLength(2);
    expect(Buffer.from(uploaded[0]!.payload!.chunk!).equals(Buffer.from(a))).toBe(true);
    expect(Buffer.from(uploaded[1]!.payload!.chunk!).equals(Buffer.from(b))).toBe(true);
  });

  it('uses the optional name as the fileset title and keeps real file names on commit (#363)', async () => {
    const file = writeSrc('clip.mp4', synth(40, 3));
    installSliceuploadOk();

    await api().createFlashTask(file, '自定义名称');

    expect(ApplyFileset.invoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fileName: '自定义名称',
      origName: '自定义名称',
      fileSize: 40,
    }));
    expect(CommitFile.invoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entries: [expect.objectContaining({ fileName: 'clip.mp4', fileSize: 40 })],
    }));
  });

  it('uses the optional name as the multi-file fileset title (#363)', async () => {
    const fileA = writeSrc('a.mp4', synth(50, 1));
    const fileB = writeSrc('b.zip', synth(70, 2));
    installSliceuploadOk();

    await api().createFlashTask([fileA, fileB], '相册');

    expect(ApplyFileset.invoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fileName: '相册',
      origName: '相册',
      fileSize: 120,
    }));
    const commit = vi.mocked(CommitFile.invoke).mock.calls[0]![1];
    expect(commit.entries[0]).toEqual(expect.objectContaining({ fileName: 'a.mp4' }));
    expect(commit.entries[1]).toEqual(expect.objectContaining({ fileName: 'b.zip' }));
  });

  it('falls back to the filename title when name is blank (#363)', async () => {
    const file = writeSrc('clip.mp4', synth(32, 9));
    installSliceuploadOk();

    await api().createFlashTask(file, '   ');

    expect(ApplyFileset.invoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      fileName: 'clip.mp4',
      origName: 'clip.mp4',
    }));
  });

  it('rejects a source that mutates between hashing and upload', async () => {
    const file = writeSrc('mut.mp4', synth(90, 5));
    const actualHash = hashMod.hashFlashFileStreaming;
    vi.spyOn(hashMod, 'hashFlashFileStreaming').mockImplementation(async (filePath) => {
      const hashes = await actualHash(filePath);
      await fsp.appendFile(filePath, Buffer.from([0xff]));
      return hashes;
    });
    installSliceuploadOk();

    await expect(api().createFlashTask(file)).rejects.toThrow(/changed during send/i);
  });
});
