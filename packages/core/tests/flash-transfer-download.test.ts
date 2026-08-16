// Regression for #364: create_flash_task can return before 0x93d4 fills
// the main-file fileId. get_flash_file_url / download_fileset poll 0x93d4
// while that field is empty, then take the normal 0x12a9 sub=200 path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GetDownloadUrl } from '@snowluma/protocol/oidb-services/flash-transfer/get-download-url';
import { GetFlashDownload } from '@snowluma/protocol/oidb-services/flash-transfer/get-flash-download';
import { FlashTransferApi } from '../src/bridge/apis/flash-transfer';

const FILESET = '8982c4b5-195c-49e2-a3ab-478b32af234c';
const FILE_ID = 'main-file-id';
const URL = 'https://multimedia.qfile.qq.com/download?appid=14901&fileid=main-file-id';

function meta(fileId: string, fileIndex = 1): GetDownloadUrl.FileMeta {
  return {
    fileIndex,
    fileId,
    filesetUuid: FILESET,
    fileUuid: 'file-uuid',
    fileName: 'sl364-hitpass.txt',
    fileSize: 41,
  };
}

function api(): FlashTransferApi {
  return new FlashTransferApi({} as never);
}

describe('FlashTransferApi.getFlashFileUrl — empty fileId poll (#364)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not wait when 0x93d4 already has the main-file fileId', async () => {
    const lookup = vi.spyOn(GetDownloadUrl, 'invoke').mockResolvedValue([meta(FILE_ID)]);
    const download = vi.spyOn(GetFlashDownload, 'invoke').mockResolvedValue(URL);

    await expect(api().getFlashFileUrl(FILESET)).resolves.toBe(URL);
    expect(lookup).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0]![1]).toMatchObject({ fileId: FILE_ID, filesetUuid: FILESET });
  });

  it('re-queries 0x93d4 after an empty fileId and then takes the download path', async () => {
    const lookup = vi.spyOn(GetDownloadUrl, 'invoke')
      .mockResolvedValueOnce([meta('')])
      .mockResolvedValueOnce([meta(FILE_ID)]);
    const download = vi.spyOn(GetFlashDownload, 'invoke').mockResolvedValue(URL);

    const pending = api().getFlashFileUrl(FILESET);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe(URL);

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0]![1]).toMatchObject({ fileId: FILE_ID });
  });

  it('shares the same poll for download_fileset', async () => {
    vi.spyOn(GetDownloadUrl, 'invoke')
      .mockResolvedValueOnce([meta('')])
      .mockResolvedValueOnce([meta(FILE_ID)]);
    vi.spyOn(GetFlashDownload, 'invoke').mockResolvedValue(URL);

    const pending = api().downloadFileset(FILESET);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({
      url: URL,
      fileName: 'sl364-hitpass.txt',
      fileSize: 41,
    });
  });

  it('keeps the original error when fileId stays empty through the budget', async () => {
    const lookup = vi.spyOn(GetDownloadUrl, 'invoke').mockResolvedValue([meta('')]);
    const download = vi.spyOn(GetFlashDownload, 'invoke').mockResolvedValue(URL);

    const pending = api().getFlashFileUrl(FILESET);
    const expectFailed = expect(pending).rejects.toThrow('get_flash_file_url: no download url available');
    await vi.advanceTimersByTimeAsync(20_000);
    await expectFailed;

    expect(lookup.mock.calls.length).toBeGreaterThan(1);
    expect(download).not.toHaveBeenCalled();
  });

  it('does not re-query 0x93d4 when fileId is present but 0x12a9 returns no url', async () => {
    const lookup = vi.spyOn(GetDownloadUrl, 'invoke').mockResolvedValue([meta(FILE_ID)]);
    vi.spyOn(GetFlashDownload, 'invoke').mockResolvedValue(null);

    await expect(api().getFlashFileUrl(FILESET)).rejects.toThrow('get_flash_file_url: no download url available');
    expect(lookup).toHaveBeenCalledOnce();
  });
});
