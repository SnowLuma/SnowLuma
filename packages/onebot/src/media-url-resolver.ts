import type { CoreCtx } from '@snowluma/core/core-ctx';
import type { MessageElement } from '@snowluma/protocol/events';
import type { RKeyCache } from './instance-rkey';

export class MediaUrlResolver {
  constructor(
    private readonly bridge: CoreCtx,
    private readonly rkeyCache: RKeyCache,
  ) { }

  async resolve(element: MessageElement, isGroup: boolean, sessionId: number): Promise<string> {
    if (!element.url) {
      try {
        await this.populateUrl(element, isGroup, sessionId);
      } catch {
        // Best-effort: a URL fetch hiccup should never block the
        // outgoing segment. The RKey pass below still runs.
      }
    }
    return this.rkeyCache.resolveMediaUrl(this.bridge, element, isGroup);
  }
  private async populateUrl(element: MessageElement, isGroup: boolean, sessionId: number): Promise<void> {
    if (element.type === 'file' && element.fileId) {
      if (isGroup) {
        element.url = await this.bridge.apis.groupFile.getUrl(sessionId, element.fileId);
      } else if (element.fileHash) {
        element.url = await this.bridge.apis.groupFile.getPrivateUrl(sessionId, element.fileId, element.fileHash);
      } else {
        element.url = '';
      }
      return;
    }

    if ((element.type === 'record' || element.type === 'video') && element.mediaNode) {
      if (isGroup) {
        element.url = element.type === 'record'
          ? await this.bridge.apis.groupFile.getPttUrl(sessionId, element.mediaNode)
          : await this.bridge.apis.groupFile.getVideoUrl(sessionId, element.mediaNode);
      } else {
        element.url = element.type === 'record'
          ? await this.bridge.apis.groupFile.getPrivatePttUrl(element.mediaNode)
          : await this.bridge.apis.groupFile.getPrivateVideoUrl(element.mediaNode);
      }
    }
  }
}
