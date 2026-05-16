// Resolves the URL for an image / record / video / file element on its
// way out of the bridge into an OneBot segment.
//
// Two steps:
//   1. If the bridge event arrived without a `url` (the receive path
//      sometimes does), fetch a fresh URL from the right Bridge API
//      based on element.type + isGroup, mutating the element in-place
//      so any downstream cache sees the URL too.
//   2. Apply the cached RKey (the per-UIN signed download key) the
//      RKeyCache knows about — both to brand-new URLs from step 1 and
//      to URLs that came in with the event already.
//
// Used as the `mediaUrlResolver` callback in `ConverterContext`.

import type { BridgeInterface } from '../bridge/bridge-interface';
import type { MessageElement } from '../bridge/events';
import type { RKeyCache } from './instance-rkey';

export class MediaUrlResolver {
  constructor(
    private readonly bridge: BridgeInterface,
    private readonly rkeyCache: RKeyCache,
  ) {}

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

  /** Branches by element.type + isGroup to pick the right Bridge API.
   *  Mutates `element.url` in-place so the caller sees the same URL
   *  the downstream rkey/media-store path will see. */
  private async populateUrl(element: MessageElement, isGroup: boolean, sessionId: number): Promise<void> {
    if (element.type === 'file' && element.fileId) {
      if (isGroup) {
        element.url = await this.bridge.fetchGroupFileUrl(sessionId, element.fileId);
      } else if (element.fileHash) {
        element.url = await this.bridge.fetchPrivateFileUrl(sessionId, element.fileId, element.fileHash);
      } else {
        element.url = '';
      }
      return;
    }

    if ((element.type === 'record' || element.type === 'video') && element.mediaNode) {
      if (isGroup) {
        element.url = element.type === 'record'
          ? await this.bridge.fetchGroupPttUrlByNode(sessionId, element.mediaNode)
          : await this.bridge.fetchGroupVideoUrlByNode(sessionId, element.mediaNode);
      } else {
        element.url = element.type === 'record'
          ? await this.bridge.fetchPrivatePttUrlByNode(element.mediaNode)
          : await this.bridge.fetchPrivateVideoUrlByNode(element.mediaNode);
      }
    }
  }
}
