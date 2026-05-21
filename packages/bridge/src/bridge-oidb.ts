import { protobuf_decode } from '@snowluma/proton';
import type { BridgeContext } from './bridge-context';
import type { OidbBase, OidbBaseMeta } from '@snowluma/proto-defs/oidb';

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
    command: oidbCmd,
    subCommand: subCmd,
    errorCode: 0,
    body,
    errorMsg: '',
    reserved: isUid ? 1 : 0,
  };
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
  bridge: BridgeContext,
  cmd: string,
  envelopeBytes: Uint8Array,
  timeoutMs?: number,
): Promise<Uint8Array> {
  const result = await bridge.sendRawPacket(cmd, envelopeBytes, timeoutMs);
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
