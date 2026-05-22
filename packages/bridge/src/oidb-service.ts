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
 * One of `subCommand` (static) or `resolveSubCommand` (dynamic from
 * params) must be present. `resolveSubCommand` wins if both are given.
 */
export interface OidbCallSpec<TReq, TResp, TParams, TResult> {
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
  /** Business params → wire-shaped request body. */
  serialize(params: TParams): TReq;
  /** Wire-shaped response body → business result. */
  deserialize(body: TResp): TResult;
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
 * sends through the supplied minimal sender capability, validates the
 * envelope's `errorCode`, decodes the body, and hands the wire-shaped
 * response to the spec's `deserialize` for transformation into the
 * business result.
 */
export async function invokeOidb<TReq, TResp, TParams, TResult>(
  sender: OidbSender,
  spec: OidbCallSpec<TReq, TResp, TParams, TResult>,
  params: TParams,
  timeoutMs?: number,
): Promise<TResult> {
  const subCommand = spec.resolveSubCommand
    ? spec.resolveSubCommand(params)
    : spec.subCommand!;
  const reqBody = spec.serialize(params);
  const env = makeOidbEnvelope(spec.command, subCommand, reqBody, spec.uinForm ?? false);
  const reqBytes = spec.encode(env);
  const wireName = spec.wireName
    ? spec.wireName(spec.command, subCommand)
    : `OidbSvcTrpcTcp.0x${spec.command.toString(16)}_${subCommand}`;

  const result = await sender.sendRawPacket(wireName, reqBytes, timeoutMs);
  if (!result.success) throw new Error(result.errorMessage || 'packet send failed');
  if (!result.gotResponse) throw new Error(result.errorMessage || 'no response');

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
  return spec.deserialize(respBody);
}

/**
 * Build the request wire bytes for a spec without sending — useful for
 * wire dump debugging, capability probing, and unit tests of the
 * encode path.
 */
export function buildOidbRequest<TReq, TResp, TParams, TResult>(
  spec: OidbCallSpec<TReq, TResp, TParams, TResult>,
  params: TParams,
): { wireName: string; bytes: Uint8Array } {
  const subCommand = spec.resolveSubCommand
    ? spec.resolveSubCommand(params)
    : spec.subCommand!;
  const reqBody = spec.serialize(params);
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
export function parseOidbResponse<TReq, TResp, TParams, TResult>(
  spec: OidbCallSpec<TReq, TResp, TParams, TResult>,
  bytes: Uint8Array,
): TResult {
  return spec.deserialize(spec.decode(bytes).body ?? ({} as TResp));
}
