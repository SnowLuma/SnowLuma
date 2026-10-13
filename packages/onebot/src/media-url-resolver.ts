import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { createLogger } from '@snowluma/common/logger';
import type { MessageElement } from '@snowluma/protocol/events';
import type { RKeyCache } from './instance-rkey';

const log = createLogger('OneBot');

export function resolveRemoteMediaUrl(
    bridge: BridgeInterface,
    type: 'record' | 'video',
    node: MessageElement['mediaNode'],
    isGroup: boolean,
    sessionId: number,
): Promise<string> {
    if (!node) {
        throw new Error(`${type} media metadata is missing`);
    }

    const api = bridge.apis.groupFile;

    if (type === 'record') {
        return isGroup ? api.getPttUrl(sessionId, node) : api.getPrivatePttUrl(node);
    }

    return isGroup ? api.getVideoUrl(sessionId, node) : api.getPrivateVideoUrl(node);
}

export class MediaUrlResolver {
    constructor(
        private readonly bridge: BridgeInterface,
        private readonly rkeyCache: RKeyCache,
    ) {}

    async resolve(element: MessageElement, isGroup: boolean, sessionId: number): Promise<string> {
        if (!element.url) {
            try {
                await this.populateUrl(element, isGroup, sessionId);
            } catch (err) {
                // Preserve the media segment when its download URL is unavailable.
                log.warn(
                    'media URL resolution failed type=%s is_group=%s: %s',
                    element.type,
                    isGroup,
                    err instanceof Error ? err.message : String(err),
                );
            }
        }

        return this.rkeyCache.resolveMediaUrl(this.bridge, element, isGroup);
    }
    private async populateUrl(
        element: MessageElement,
        isGroup: boolean,
        sessionId: number,
    ): Promise<void> {
        if (element.type === 'file' && element.fileId) {
            if (isGroup) {
                element.url = await this.bridge.apis.groupFile.getUrl(sessionId, element.fileId);
            } else if (element.fileHash) {
                element.url = await this.bridge.apis.groupFile.getPrivateUrl(
                    sessionId,
                    element.fileId,
                    element.fileHash,
                );
            } else {
                element.url = '';
            }

            return;
        }

        if ((element.type === 'record' || element.type === 'video') && element.mediaNode) {
            element.url = await resolveRemoteMediaUrl(
                this.bridge,
                element.type,
                element.mediaNode,
                isGroup,
                sessionId,
            );
        }
    }
}
