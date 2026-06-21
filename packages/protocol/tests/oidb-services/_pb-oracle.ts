// Independent protobuf byte-oracle helpers for OIDB service tests.
//
// These build expected wire bytes from FIRST PRINCIPLES (the RE'd tag
// numbers), NOT via proton — so asserting `proton.encode(...) === pb.env(...)`
// goes red if a proto-defs field tag is wrong or silently changes. A
// symmetric encode→decode round-trip can't catch a tag swap; this can.
//
// Emission rules mirror proton's observed behaviour: fields in ASCENDING
// tag order, and proto3 defaults (0 / '' / false) OMITTED.

function uvarint(n: number): number[] {
  const out: number[] = [];
  let x = n;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b |= 0x80;
    out.push(b);
  } while (x > 0);
  return out;
}

function tag(field: number, wire: number): number[] {
  return uvarint(field * 8 + wire);
}

/** varint field (wire type 0). */
export function v(field: number, value: number): number[] {
  return [...tag(field, 0), ...uvarint(value)];
}

/** length-delimited string field (wire type 2). */
export function s(field: number, str: string): number[] {
  const b = [...Buffer.from(str, 'utf8')];
  return [...tag(field, 2), ...uvarint(b.length), ...b];
}

/** length-delimited sub-message field (wire type 2). */
export function m(field: number, msg: number[]): number[] {
  return [...tag(field, 2), ...uvarint(msg.length), ...msg];
}

/**
 * Wrap a body in the OidbBase envelope exactly as proton emits it:
 * command(1), subCommand(2) [omitted when 0], body(4), reserved(12)=1
 * [only when uinForm]. errorCode(3)/errorMsg(5) are defaults → omitted.
 */
export function env(command: number, subCommand: number, body: number[], uinForm: boolean): string {
  const out = [...v(1, command)];
  if (subCommand !== 0) out.push(...v(2, subCommand));
  out.push(...m(4, body));
  if (uinForm) out.push(...v(12, 1));
  return Buffer.from(out).toString('hex');
}
