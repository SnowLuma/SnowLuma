import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { MediaUrlResolver } from '../src/media-url-resolver';
import { RKeyCache } from '../src/instance-rkey';
import type { MessageElement } from '@snowluma/protocol/events';

function makeBridge(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return {
        apis: {
            groupFile: {
                getUrl: overrides.getUrl ?? vi.fn(async () => 'http://group/file'),
                getPrivateUrl: overrides.getPrivateUrl ?? vi.fn(async () => 'http://private/file'),
                getPttUrl: overrides.getPttUrl ?? vi.fn(async () => 'http://group/ptt'),
                getPrivatePttUrl:
                    overrides.getPrivatePttUrl ?? vi.fn(async () => 'http://private/ptt'),
                getVideoUrl: overrides.getVideoUrl ?? vi.fn(async () => 'http://group/video'),
                getPrivateVideoUrl:
                    overrides.getPrivateVideoUrl ?? vi.fn(async () => 'http://private/video'),
            },
        },
    };
}

function makeRkey(overrides: { resolveMediaUrl?: ReturnType<typeof vi.fn> } = {}) {
    return {
        resolveMediaUrl:
            overrides.resolveMediaUrl ?? vi.fn(async (_bridge, el: MessageElement) => el.url ?? ''),
    };
}

const MEDIA_NODE = { fileUuid: 'uuid-1' };

describe('MediaUrlResolver — file element', () => {
    let bridge: ReturnType<typeof makeBridge>;
    let rkey: ReturnType<typeof makeRkey>;
    beforeEach(() => {
        bridge = makeBridge();
        rkey = makeRkey();
    });

    it('group + fileId: uses fetchGroupFileUrl, then applies rkey', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'file', fileId: 'fid-x' };
        const out = await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getUrl).toHaveBeenCalledWith(12345, 'fid-x');
        expect(element.url).toBe('http://group/file');
        expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
        expect(out).toBe('http://group/file');
    });

    it('c2c + fileId + fileHash: uses fetchPrivateFileUrl', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'file', fileId: 'fid-x', fileHash: 'hash-y' };
        await resolver.resolve(element, false, 67890);
        expect(bridge.apis.groupFile.getPrivateUrl).toHaveBeenCalledWith(67890, 'fid-x', 'hash-y');
        expect(element.url).toBe('http://private/file');
    });

    it('c2c + fileId but no fileHash: sets url to empty string (no bridge call)', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'file', fileId: 'fid-x' };
        await resolver.resolve(element, false, 67890);
        expect(bridge.apis.groupFile.getPrivateUrl).not.toHaveBeenCalled();
        expect(element.url).toBe('');
    });
});

describe('MediaUrlResolver — record / video element', () => {
    let bridge: ReturnType<typeof makeBridge>;
    let rkey: ReturnType<typeof makeRkey>;
    beforeEach(() => {
        bridge = makeBridge();
        rkey = makeRkey();
    });

    it('group record: uses fetchGroupPttUrlByNode', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'record', mediaNode: MEDIA_NODE };
        await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getPttUrl).toHaveBeenCalledWith(12345, MEDIA_NODE);
        expect(element.url).toBe('http://group/ptt');
    });

    it('c2c record: uses fetchPrivatePttUrlByNode (no sessionId argument)', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'record', mediaNode: MEDIA_NODE };
        await resolver.resolve(element, false, 67890);
        expect(bridge.apis.groupFile.getPrivatePttUrl).toHaveBeenCalledWith(MEDIA_NODE);
        expect(element.url).toBe('http://private/ptt');
    });

    it('group video: uses fetchGroupVideoUrlByNode', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'video', mediaNode: MEDIA_NODE };
        await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getVideoUrl).toHaveBeenCalledWith(12345, MEDIA_NODE);
        expect(element.url).toBe('http://group/video');
    });

    it('c2c video: uses fetchPrivateVideoUrlByNode', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'video', mediaNode: MEDIA_NODE };
        await resolver.resolve(element, false, 67890);
        expect(bridge.apis.groupFile.getPrivateVideoUrl).toHaveBeenCalledWith(MEDIA_NODE);
        expect(element.url).toBe('http://private/video');
    });

    it('record without mediaNode: no bridge call, url untouched', async () => {
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'record' };
        await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getPttUrl).not.toHaveBeenCalled();
        expect(element.url).toBeUndefined();
    });
});

describe('MediaUrlResolver — short-circuits and resilience', () => {
    it('element.url already set: no bridge call, just rkey pass', async () => {
        const bridge = makeBridge();
        const rkey = makeRkey();
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'file', fileId: 'fid', url: 'already-set' };
        await resolver.resolve(element, true, 12345);
        expect(bridge.apis.groupFile.getUrl).not.toHaveBeenCalled();
        expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
    });

    it.each([
        ['file', true, 'getUrl'],
        ['file', false, 'getPrivateUrl'],
        ['record', true, 'getPttUrl'],
        ['record', false, 'getPrivatePttUrl'],
        ['video', true, 'getVideoUrl'],
        ['video', false, 'getPrivateVideoUrl'],
    ] as const)(
        '%s group=%s: reports URL failure and preserves the media',
        async (type, isGroup, method) => {
            const bridge = makeBridge({
                [method]: vi.fn().mockRejectedValue(new Error('network down')),
            });
            const resolver = new MediaUrlResolver(bridge as any, new RKeyCache());
            const element: MessageElement = {
                type,
                fileId: 'fid',
                fileHash: 'hash',
                mediaNode: MEDIA_NODE,
            };
            const original = structuredClone(element);
            const entries: LogEntry[] = [];
            const unsubscribe = subscribeLogs((entry) => entries.push(entry));

            try {
                await expect(resolver.resolve(element, isGroup, 12345)).resolves.toBe('');
                expect(element).toEqual(original);
                expect(entries).toContainEqual(
                    expect.objectContaining({
                        level: 'warn',
                        message: expect.stringMatching(/media URL resolution failed.*network down/),
                    }),
                );
            } finally {
                unsubscribe();
            }
        },
    );

    it('always calls rkey.resolveMediaUrl at the end', async () => {
        const bridge = makeBridge();
        const rkey = makeRkey({ resolveMediaUrl: vi.fn(async () => 'http://signed') });
        const resolver = new MediaUrlResolver(bridge as any, rkey as any);
        const element: MessageElement = { type: 'image' };
        const out = await resolver.resolve(element, true, 12345);
        expect(rkey.resolveMediaUrl).toHaveBeenCalledOnce();
        expect(out).toBe('http://signed');
    });
});
