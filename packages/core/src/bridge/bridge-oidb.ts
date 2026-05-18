// One deep entry point for a single OIDB round-trip: dispatch a
// pre-encoded envelope via Bridge.sendRawPacket, validate the envelope
// retCode, and return the raw response bytes.
//
// History note. The legacy implementation used a runtime
// `makeOidbBaseSchema(InnerSchema)` factory and ran a runtime
// schema-walking encoder. Proton is compile-time, so the envelope is
// the generic interface `OidbBase<T>` (proto/proton/oidb.ts). Proton's
// wrapper-binding requires *pass-through* wrappers (the wrapper's first
// arg must be forwarded unchanged to the inner codec — see
// proton/src/transform/replacer.ts), so this file exposes thin
// pass-through helpers (`encodeOidbEnv<T>` / `decodeOidbEnv<T>`) that
// proton monomorphizes at every call site. `runOidb` itself is
// non-generic — it just sends pre-encoded bytes and peeks at the
// envelope retCode via the non-generic `OidbBaseMeta` view.

import type { Bridge } from './bridge';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import type { OidbBase, OidbBaseMeta } from './proto/proton/oidb';

/**
 * Build the OidbBase<T>-shaped TS value. Pure helper, no protobuf
 * encoding happens here — pair with `encodeOidbEnv<T>` to produce the
 * wire bytes.
 *
 * The `isUid` flag sets the envelope `reserved` field to 1; despite the
 * name (kept for back-compat with the legacy API), `reserved = 1`
 * empirically signals the UIN-form variant of an OIDB call. Omit
 * (default false) for genuinely UID-keyed calls.
 */
export function makeOidbEnvelope<T>(
  oidbCmd: number,
  subCmd: number,
  body: T,
  isUid: boolean = false,
): OidbBase<T> {
  return {
    command:    oidbCmd,
    subCommand: subCmd,
    errorCode:  0,
    body,
    errorMsg:   '',
    reserved:   isUid ? 1 : 0,
  };
}

/**
 * Pass-through encoder for the OIDB envelope. Single type param, body
 * literally forwards its arg to `protobuf_encode<OidbBase<T>>` — proton
 * wrapper-binds this and replaces every `encodeOidbEnv<MyReq>(env)` call
 * site with `protobuf_encode_OidbBase__MyReq(env)` at build time.
 */
export function encodeOidbEnv<T>(env: OidbBase<T>): Uint8Array {
  return protobuf_encode<OidbBase<T>>(env);
}

/**
 * Pass-through decoder for the OIDB envelope. Mirror of `encodeOidbEnv`
 * — proton monomorphizes `OidbBase<TResp>` per call site.
 *
 * Returns the full envelope; the caller usually wants `.body`.
 */
export function decodeOidbEnv<T>(bytes: Uint8Array): OidbBase<T> {
  return protobuf_decode<OidbBase<T>>(bytes);
}

/**
 * Issue one OIDB request and return the raw response bytes.
 *
 * Typical usage:
 *   const env  = makeOidbEnvelope<MyReq>(0x1253, 1, value);
 *   const buf  = await runOidb(bridge, cmd, encodeOidbEnv<MyReq>(env));
 *   const resp = decodeOidbEnv<MyResp>(buf).body;
 *
 * Fire-and-check (no body decode):
 *   await runOidb(bridge, cmd, encodeOidbEnv<MyReq>(env));
 *
 * Always peeks at the envelope errorCode via the non-generic
 * `OidbBaseMeta` view so a server-side rejection cannot slip past
 * silently. Returns the raw response bytes (empty `Uint8Array` if the
 * packet carried no payload).
 */
export async function runOidb(
  bridge: Bridge,
  cmd: string,
  envelopeBytes: Uint8Array,
): Promise<Uint8Array> {
  const result = await bridge.sendRawPacket(cmd, envelopeBytes);
  if (!result.success) throw new Error(result.errorMessage || 'packet send failed');
  if (!result.gotResponse) throw new Error(result.errorMessage || 'no response');

  const bytes = result.responseData ?? new Uint8Array(0);
  if (bytes.length > 0) {
    const meta = protobuf_decode<OidbBaseMeta>(bytes);
    const code = meta?.errorCode;
    if (code && code !== 0) {
      throw new Error(`OIDB error ${code}: ${meta?.errorMsg ?? ''}`);
    }
  }
  return bytes;
}
