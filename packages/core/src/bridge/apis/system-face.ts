import {
  sysFaceStore,
  type SysFaceEntry,
  type SysFacePackEntry,
} from '@snowluma/protocol/sys-face-store';
import { isSuperFaceEntry } from '@snowluma/protocol/oidb-services/sys-faces/fetch-sys-faces';
import type { BridgeContext } from '../bridge-context';

/** QQ's account-independent system-face directory. The shared store owns
 * persistence and refresh coalescing; this API binds it to one live sender. */
export class SystemFaceApi {
  constructor(private readonly ctx: BridgeContext) {}

  fetchCatalog(refresh = false): Promise<SysFacePackEntry[]> {
    return sysFaceStore.getCatalog(this.ctx, refresh);
  }

  async fetchFace(faceId: number, refresh = false): Promise<SysFaceEntry | null> {
    if (refresh) {
      await sysFaceStore.refresh(this.ctx);
      return sysFaceStore.lookup(faceId);
    }
    return sysFaceStore.resolve(this.ctx, faceId);
  }

  async search(query: string): Promise<SysFaceEntry[]> {
    await sysFaceStore.ensureReady(this.ctx);
    return sysFaceStore.search(query);
  }

  async isSuper(faceId: number, refresh = false): Promise<boolean> {
    const face = await this.fetchFace(faceId, refresh);
    return face !== null && isSuperFaceEntry(face);
  }
}
