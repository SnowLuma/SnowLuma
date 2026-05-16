// One deep entry point for a single OIDB round-trip: build the envelope,
// dispatch via Bridge.sendRawPacket, validate the response status, and
// optionally decode the body. Replaces the three positional helpers
// (makeOidbRequest / sendOidbAndCheck / sendOidbAndDecode) that used to
// scatter the same five-step pattern across every action file.

import type { Bridge } from './bridge';
import type { ProtoSchema } from '../protobuf/decode';
import { protoEncode, protoDecode } from '../protobuf/decode';
import { makeOidbBaseSchema } from './proto/oidb';

export interface OidbCall<TResp = void> {
  /** Service-cmd string sent on the wire, e.g. 'OidbSvcTrpcTcp.0x1253_1'. */
  cmd: string;
  /** OIDB command number, e.g. 0x1253. */
  oidbCmd: number;
  /** OIDB sub-command, e.g. 1. */
  subCmd: number;
  request: {
    schema: ProtoSchema;
    value: any;
    /**
     * Sets the OIDB envelope `reserved` field to 1 when true. A handful
     * of commands (group/friend list, rkey download) operate on
     * UID-keyed data and require this flag — the wire format is
     * otherwise identical.
     */
    isUid?: boolean;
  };
  /** Omit to skip decoding the response body (fire-and-check). */
  response?: {
    schema: ProtoSchema;
  };
}

/**
 * Issue one OIDB request. Without `response`, returns void after
 * verifying the envelope's retCode. With `response`, decodes the
 * envelope, validates retCode, and returns the inner body.
 *
 * Throws on transport failure, missing response, decode failure, or any
 * non-zero envelope retCode. Action modules layer their own retCode
 * checks (on inner sub-replies like `upload.retCode`) on top of this.
 */
export function runOidb(bridge: Bridge, call: OidbCall<void> & { response?: undefined }): Promise<void>;
export function runOidb<TResp>(bridge: Bridge, call: OidbCall<TResp> & { response: { schema: ProtoSchema } }): Promise<TResp>;
export async function runOidb<TResp>(bridge: Bridge, call: OidbCall<TResp>): Promise<TResp | void> {
  const envelope = encodeOidbEnvelope(call);
  const result = await bridge.sendRawPacket(call.cmd, envelope);
  if (!result.success) throw new Error(result.errorMessage || 'packet send failed');

  if (call.response) {
    if (!result.gotResponse || !result.responseData) {
      throw new Error(result.errorMessage || 'no response');
    }
    const baseSchema = makeOidbBaseSchema(call.response.schema);
    const resp = protoDecode(result.responseData, baseSchema);
    if (!resp) throw new Error('failed to decode OIDB response');
    throwIfOidbError(resp);
    return (resp as any).body as TResp;
  }

  // Fire-and-check: response data is optional, but if present we still
  // peek at the envelope so a server-side retCode doesn't silently slip past.
  if (!result.gotResponse) throw new Error(result.errorMessage || 'no response');
  if (result.responseData && result.responseData.length > 0) {
    const emptyBase = makeOidbBaseSchema({ _dummy: { field: 99, type: 'uint32' as const } });
    const resp = protoDecode(result.responseData, emptyBase);
    if (resp) throwIfOidbError(resp);
  }
}

function encodeOidbEnvelope(call: OidbCall<unknown>): Uint8Array {
  const baseSchema = makeOidbBaseSchema(call.request.schema);
  return protoEncode({
    command: call.oidbCmd,
    subCommand: call.subCmd,
    errorCode: 0,
    body: call.request.value,
    errorMsg: '',
    reserved: call.request.isUid ? 1 : 0,
  }, baseSchema);
}

function throwIfOidbError(resp: unknown): void {
  const code = (resp as any).errorCode;
  if (code && code !== 0) {
    throw new Error(`OIDB error ${code}: ${(resp as any).errorMsg ?? ''}`);
  }
}
