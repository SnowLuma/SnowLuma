// Regression coverage for large-video → file-upload fallback.
//
// When a video exceeds QQ's Highway video ceiling the element-pipeline
// send throws. The OneBot layer catches that and re-routes the video
// through the dedicated file-upload pipeline (group: groupFile.upload,
// private: groupFile.uploadPrivate). The element-builder cannot produce
// a group file element on its own because it has no uploaded file_id at
// build time — so the fallback MUST live at the OneBot layer for both
// scenes (private already did; #153 left the group side broken).

import { describe, expect, it, vi } from 'vitest';
import type { MessageElement } from '@snowluma/protocol/events';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { OneBotInstanceContext } from '../src/instance-context';
import { sendGroupMessage, videoNeedsFileFallback } from '../src/modules/message-actions';

const MB = 1024 * 1024;

function fakeBridge(overrides: Partial<BridgeInterface> = {}): BridgeInterface {
  return new Proxy(overrides as BridgeInterface, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      throw new Error(`fakeBridge: '${String(prop)}' was not stubbed for this test`);
    },
  });
}

function makeCtx(bridge: BridgeInterface): OneBotInstanceContext {
  return {
    uin: '10001',
    bridge,
    messageStore: { findEvent: () => null, resolveReplySequence: () => 0 } as any,
    cacheMessageMeta: vi.fn(),
    mediaStore: {} as any,
    musicSignUrl: '',
  } as unknown as OneBotInstanceContext;
}

describe('send_group_msg large-video fallback', () => {
  it('routes the video through groupFile.upload when the Highway send fails with a size error', async () => {
    const sendGroup = vi.fn(async (_gid: number, _elements: any[]) => {
      throw new Error('video file too large: 1200 MB exceeds limit');
    });
    const upload = vi.fn(async (_gid: number, _src: string, _name: string, _folder: string, _doUpload: boolean) =>
      ({ fileId: 'auto-fid', fileHash: null }));
    const publish = vi.fn();
    const bridge = fakeBridge({
      apis: {
        message: { sendGroup },
        groupFile: { upload, publish },
      } as any,
      resolveUserUid: vi.fn(),
    } as any);
    const ctx = makeCtx(bridge);

    await sendGroupMessage(ctx, 12345, [{
      type: 'video', data: { file: 'http://example.com/big.mp4' },
    }] as any, false);

    // Highway send was attempted once (and threw)...
    expect(sendGroup).toHaveBeenCalledOnce();
    // ...then the video was re-routed through the group file pipeline.
    expect(upload).toHaveBeenCalledOnce();
    const [gid, src, name] = upload.mock.calls[0]!;
    expect(gid).toBe(12345);
    expect(src).toBe('http://example.com/big.mp4');
    expect(name).toBe('video.mp4');
    // upload() publishes internally — no second publish().
    expect(publish).not.toHaveBeenCalled();
  });

  it('rethrows (no fallback) when a remote video fails with a non-size error', async () => {
    // Size can't be inferred for a remote URL, and the error isn't
    // size-related — we must not silently swallow an unrelated failure
    // by converting it to a file upload.
    const sendGroup = vi.fn(async (_gid: number, _elements: any[]) => {
      throw new Error('network reset while streaming chunk 3');
    });
    const upload = vi.fn();
    const bridge = fakeBridge({
      apis: {
        message: { sendGroup },
        groupFile: { upload, publish: vi.fn() },
      } as any,
      resolveUserUid: vi.fn(),
    } as any);
    const ctx = makeCtx(bridge);

    await expect(sendGroupMessage(ctx, 12345, [{
      type: 'video', data: { file: 'http://example.com/big.mp4' },
    }] as any, false)).rejects.toThrow('network reset');

    expect(upload).not.toHaveBeenCalled();
  });
});

describe('videoNeedsFileFallback', () => {
  it('triggers on a known oversize source regardless of the error message', () => {
    // The real-bot case: a local 1.4 GB video whose Highway upload fails
    // with a cryptic `error_code=323` (not size-worded). Source size is
    // known, so the file fallback must still fire.
    const big = { type: 'video', fileSize: 1400 * MB } as MessageElement;
    expect(videoNeedsFileFallback(big, /* isSizeErr */ false)).toBe(true);
  });

  it('does not trigger for a known under-limit source', () => {
    const small = { type: 'video', fileSize: 50 * MB } as MessageElement;
    expect(videoNeedsFileFallback(small, true)).toBe(false);
  });

  it('falls back to the error heuristic when the source size is unknown', () => {
    const remote = { type: 'video', url: 'http://example.com/v.mp4' } as MessageElement;
    expect(videoNeedsFileFallback(remote, true)).toBe(true);
    expect(videoNeedsFileFallback(remote, false)).toBe(false);
  });

  it('never triggers for non-video elements', () => {
    const img = { type: 'image', fileSize: 1400 * MB } as MessageElement;
    expect(videoNeedsFileFallback(img, true)).toBe(false);
  });
});
