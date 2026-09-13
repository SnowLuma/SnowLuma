import type { OidbBase } from '@snowluma/proto-defs/oidb';

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

