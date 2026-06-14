// OIDB service layer — the next architectural revision on top of the
// area-grouped Api facade pattern (InteractionApi / ProfileApi / …).
//
// Each OIDB cmd is modelled as a TypeScript namespace whose exported
// members ARE the `OidbCallSpec` shape (structural typing makes this
// implicit — no `implements` clause needed). The namespace also exports
// a thin `invoke()` that hands itself to `invokeOidb` for dispatch.
//
// Why namespace-as-spec instead of class:
//   - stateless: no `new` overhead at the call site
//   - no `this` binding, no implicit lifecycle
//   - tree-shakes per-export (unused services drop out of the bundle)
//   - spec ↔ code 1:1 (one file = one (cmd, subcmd) tuple)
//
// Why Pick-style minimal `Deps` per service:
//   - Interface Segregation: a wire-only cmd doesn't see identity/events
//   - tests mock only what's used (typically just `sendRawPacket`)
//   - changes to BridgeContext don't bleed into services
//   - the dep list IS the documentation of side-effects
//
// Why `ctx` threads into serialize/deserialize:
//   - the namespace is then genuinely self-contained — "what does this
//     cmd do on the wire + what state does it touch" lives in one file
//   - earlier shape forced an `invoke = { ...Self, serialize: p =>
//     localSerialize(p, await ctx.resolveUserUid(...)) }` rewrite for
//     every cmd that needed identity/uid resolution; ctx-aware
//     serialize collapses that to a single async serialize.
//   - serialize is now `TReq | Promise<TReq>` so async lookups
//     (resolveUserUid, identity reads) happen in place.

import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase, OidbBaseMeta } from '@snowluma/proto-defs/oidb';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { makeOidbEnvelope } from './bridge-oidb';

/**
 * Capability narrow enough for any wire-only OIDB call. Anything that
 * also needs identity / event bus / upload cache declares those via
 * `Pick<BridgeContext, 'identity' | …>` and intersects with this.
 */
export interface OidbSender {
  sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs?: number): Promise<SendPacketResult>;
}

/**
 * The shape every cmd namespace exports. Structural typing means a
 * namespace whose top-level exports match these names + types IS an
 * `OidbCallSpec` — no `implements` clause needed.
 *
 * `TCtx` is the namespace's capability surface — always at least
 * `OidbSender` (so `invokeOidb` can dispatch through it) plus any
 * `Pick<BridgeContext, ...>` slices the cmd actually needs.
 *
 * One of `subCommand` (static) or `resolveSubCommand` (dynamic from
 * params) must be present. `resolveSubCommand` wins if both are given.
 */
export interface OidbCallSpec<TCtx extends OidbSender, TReq, TResp, TParams, TResult> {
  command: number;
  subCommand?: number;
  resolveSubCommand?(params: TParams): number;
  /** Set OIDB envelope `reserved = 1` (UIN-form variant, see makeOidbEnvelope's isUid). */
  uinForm?: boolean;
  /** Override the default `OidbSvcTrpcTcp.0xNNNN_N` wire name. A few
   *  cmds route through different SSO names (e.g. 0xE17_0 lives at
   *  `MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0`); supply a function
   *  that takes the resolved `(cmd, subCmd)` and returns the actual
   *  wire name. Omit for the default scheme. */
  wireName?(command: number, subCommand: number): string;
  /** Business params → wire-shaped request body. May be async (e.g.
   *  when ctx.resolveUserUid hits the cache or the network). */
  serialize(ctx: TCtx, params: TParams): TReq | Promise<TReq>;
  /** Wire-shaped response body → business result. */
  deserialize(ctx: TCtx, body: TResp): TResult;
  /** Per-type protobuf encoder — concrete generic call so the Vite plugin can monomorphize. */
  encode(env: OidbBase<TReq>): Uint8Array;
  /** Per-type protobuf decoder. */
  decode(bytes: Uint8Array): OidbBase<TResp>;
}

export class OidbError extends Error {
  constructor(
    readonly code: number,
    readonly serverMsg: string,
    readonly command: number,
    readonly subCommand: number,
  ) {
    super(`OIDB error ${code} on 0x${command.toString(16)}_${subCommand}: ${serverMsg}`);
    this.name = 'OidbError';
  }
}

/**
 * Template method for every OIDB call. Builds the envelope, encodes it,
 * sends through the ctx's `sendRawPacket`, validates the envelope's
 * `errorCode`, decodes the body, and hands the wire-shaped response to
 * the spec's `deserialize` for transformation into the business result.
 *
 * `ctx` is threaded into both `serialize` and `deserialize` so the
 * namespace can do uid resolution / identity reads in-place rather
 * than forcing the caller to pre-bake values into the params.
 */
export async function invokeOidb<TCtx extends OidbSender, TReq, TResp, TParams, TResult>(
  ctx: TCtx,
  spec: OidbCallSpec<TCtx, TReq, TResp, TParams, TResult>,
  params: TParams,
  timeoutMs?: number,
): Promise<TResult> {
  const subCommand = spec.resolveSubCommand
    ? spec.resolveSubCommand(params)
    : spec.subCommand!;
  const reqBody = await spec.serialize(ctx, params);
  const env = makeOidbEnvelope(spec.command, subCommand, reqBody, spec.uinForm ?? false);
  const reqBytes = spec.encode(env);
  const wireName = spec.wireName
    ? spec.wireName(spec.command, subCommand)
    : `OidbSvcTrpcTcp.0x${spec.command.toString(16)}_${subCommand}`;

  const result = await ctx.sendRawPacket(wireName, reqBytes, timeoutMs);
  if (!result.gotResponse) throw new Error(result.errorMessage || 'no response');

  if (!result.success) {
    if (result.errorCode && result.errorCode !== 0) {
      throw new OidbError(
        result.errorCode,
        result.errorMessage || '',
        spec.command,
        subCommand
      );
    }
    // success=false without an OIDB error code = the packet send itself failed;
    // surface it instead of silently resolving with an undecoded response.
    throw new Error(result.errorMessage || 'packet send failed');
  }

  const respBytes = result.responseData ?? new Uint8Array(0);
  if (respBytes.length > 0) {
    const meta = protobuf_decode<OidbBaseMeta>(respBytes);
    const code = meta?.errorCode;
    if (code && code !== 0) {
      throw new OidbError(code, meta?.errorMsg ?? '', spec.command, subCommand);
    }
  }

  // Server may legitimately respond with an empty envelope (ack-only
  // cmds like 0x9082_1 — the response carries only `errorCode = 0`
  // and no body). Substitute an empty placeholder so `deserialize`
  // always receives a defined object; specs that read fields off the
  // body must already guard with `?? []` etc.
  const respBody = spec.decode(respBytes).body ?? ({} as TResp);
  return spec.deserialize(ctx, respBody);
}

/**
 * Build the request wire bytes for a spec without sending — useful for
 * wire dump debugging, capability probing, and unit tests of the
 * encode path. Threads `ctx` because `serialize` may want it (and
 * because matching `invokeOidb`'s shape avoids two call patterns).
 */
export async function buildOidbRequest<TCtx extends OidbSender, TReq, TResp, TParams, TResult>(
  ctx: TCtx,
  spec: OidbCallSpec<TCtx, TReq, TResp, TParams, TResult>,
  params: TParams,
): Promise<{ wireName: string; bytes: Uint8Array }> {
  const subCommand = spec.resolveSubCommand
    ? spec.resolveSubCommand(params)
    : spec.subCommand!;
  const reqBody = await spec.serialize(ctx, params);
  const env = makeOidbEnvelope(spec.command, subCommand, reqBody, spec.uinForm ?? false);
  const bytes = spec.encode(env);
  const wireName = spec.wireName
    ? spec.wireName(spec.command, subCommand)
    : `OidbSvcTrpcTcp.0x${spec.command.toString(16)}_${subCommand}`;
  return { wireName, bytes };
}

/**
 * Decode raw wire bytes into the business result via a spec's
 * deserialize path — symmetric debug helper for buildOidbRequest.
 */
export function parseOidbResponse<TCtx extends OidbSender, TReq, TResp, TParams, TResult>(
  ctx: TCtx,
  spec: OidbCallSpec<TCtx, TReq, TResp, TParams, TResult>,
  bytes: Uint8Array,
): TResult {
  return spec.deserialize(ctx, spec.decode(bytes).body ?? ({} as TResp));
}
