// BridgeContext — the surface that Api classes (and any external
// consumer that doesn't need the full Bridge concrete class) see.
//
// Replaces the previous `BridgeInterface`, which had grown to ~170 lines
// listing every Bridge method one-by-one and was a maintenance burden
// (every new feature meant +1 signature here, +1 method on Bridge, +1
// stub in `mockBridge`). The new design splits business methods OUT to
// `apis.xxx.method()` — this interface now carries only the
// "infrastructure" surface every Api class needs:
//
//   - state: identity / events / apis (per-instance)
//   - raw I/O: sendRawPacket, resolveUserUid
//   - protocol helpers: nextMessageRandom / nextClientSequence
//   - upload metadata cache: rememberUploadedFile / recallUploadedFile
//
// Anything beyond that lives in `apis.<area>.method()` — see
// `bridge/apis/index.ts` for the ApiHub shape.
//
// The concrete `Bridge` class still `implements BridgeContext`, so
// passing a `Bridge` where a `BridgeContext` is expected is a free
// upcast. Test fakes go the other direction: build a small object that
// only stubs the fields under test (instead of the previous 70+ method
// `MockBridge` god-object) and pass it as `BridgeContext`.

import type { IdentityService } from './identity-service';
import type { BridgeEventBus } from './event-bus';
import type { ApiHub } from './apis';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { UploadedFileMeta } from './bridge';

export interface BridgeContext {
  // ── Per-instance state (one set per QQ account in a multi-account
  //    runtime; `BridgeManager` allocates one `Bridge` per uin and
  //    each Bridge owns its own identity/events/pipeline/apis). ──
  readonly identity: IdentityService;
  readonly events: BridgeEventBus;
  readonly apis: ApiHub;

  // ── Raw I/O ──
  /** Escape hatch for arbitrary protocol calls (used by Api classes
   * and by the `send_packet` OneBot action). Every typed wrapper on an
   * Api class eventually routes through here. */
  sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs?: number): Promise<SendPacketResult>;
  /** uin → uid lookup (cached in IdentityService). `groupId` is an
   * optional hint that lets the resolver fall back to a group-member
   * roster when the friend list doesn't have the uin. */
  resolveUserUid(uin: number, groupId?: number): Promise<string>;

  // ── Send-side protocol helpers (Api classes that build a
  //    `SendMessageRequest` need these monotonic generators to fill in
  //    `clientSequence` and `random`). They were previously `private`
  //    on Bridge — promoted to public so the new Api classes can call
  //    them without `(bridge as any).nextXxx()`. ──
  nextMessageRandom(): number;
  nextClientSequence(): number;

  // ── Uploaded-file metadata cache ──
  //
  // Bookkeeping shared between `GroupFileApi.upload*File` (writes the
  // tuple at upload time) and `MessageApi.sendPrivateMessage` (reads
  // it on later `send_msg` calls that carry only a file_id). Lives at
  // this layer rather than inside `GroupFileApi` because the message
  // send path is what queries the cache, and it shouldn't have to
  // reach into a different Api class for an infrastructure lookup.
  rememberUploadedFile(meta: UploadedFileMeta): void;
  recallUploadedFile(fileId: string): UploadedFileMeta | undefined;
}
