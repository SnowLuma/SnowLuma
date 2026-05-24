// BridgeContext — the protocol-layer surface that anything inside
// @snowluma/protocol (highway uploaders, OIDB envelope helper, element
// builder, msg-push parsers) accepts when it needs `bridge.identity`
// or `bridge.sendRawPacket` plus the upload-metadata cache.
//
// Deliberately apis-less: @snowluma/protocol knows nothing about the
// `apis.<area>.method()` hub that lives in @snowluma/core, so the
// type that bridge code accepts must NOT mention `ApiHub`. The api-
// layer's own extended context (with `apis: ApiHub`) lives at
// @snowluma/core's same-named file and `extends` this one — Api
// classes import from THERE, bridge helpers import from HERE.
//
// The concrete `Bridge` class (in @snowluma/core) implements the
// extended interface, which is a superset of this one. Passing a
// `Bridge` where a slim `BridgeContext` is expected is a free upcast.

import type { IdentityService } from './identity-service';
import type { BridgeEventBus } from './event-bus';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

/**
 * Metadata remembered after `upload_group_file` / `upload_private_file`
 * succeeds. Lets the OneBot send-message path reconstruct the full
 * payload when the caller only echoes the `file_id` back later. Lives
 * here (not on @snowluma/core's `bridge.ts`) so element-builder + the
 * forward-builder — both inside @snowluma/protocol — can read the cache
 * without circular-importing @snowluma/core.
 */
export interface UploadedFileMeta {
  fileId: string;
  scope: 'group' | 'private';
  /** Group id if scope='group', else `undefined`. */
  groupId?: number;
  /** Friend uin if scope='private', else `undefined`. */
  userId?: number;
  fileName: string;
  fileSize: number;
  fileMd5: Uint8Array;
  fileSha1: Uint8Array;
  /** Server-issued hash returned alongside the upload (private only). */
  fileHash?: string;
  /** Insert time — used to evict the oldest entry when the cache fills. */
  rememberedAt: number;
}

export interface BridgeContext {
  // ── Per-instance state (one set per QQ account in a multi-account
  //    runtime; `BridgeManager` allocates one `Bridge` per uin and
  //    each Bridge owns its own identity/events/pipeline/apis). ──
  readonly identity: IdentityService;
  readonly events: BridgeEventBus;

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
