// Receive-side decode for `com.tencent.multimsg` LightApp — verifies
// the inverse of element-builder.makeForwardElem so a forward sent by
// SnowLuma (or any QQ-NT / Lagrange / NapCat client) round-trips
// back to `{type: 'forward', resId, forwardUuid}` on the receiver.
//
// Without this the receiver-side decoder sees `lightApp` and falls
// back to a generic `{type: 'json', text: <json>}` element, which
// means the OneBot layer can't surface a forward bubble OR walk into
// the nested forward via fetch(resId).

import { describe, expect, it } from 'vitest';
import { deflateSync } from 'zlib';
import { decodeRichBody } from '../../src/msg-push/rich-body-decoder';
import type { MessageBody } from '@snowluma/proto-defs/message';

function lightAppBytes(json: unknown): Uint8Array {
  const buf = deflateSync(Buffer.from(JSON.stringify(json), 'utf8'));
  const out = new Uint8Array(buf.length + 1);
  out[0] = 0x01;  // deflate prefix
  out.set(buf, 1);
  return out;
}

describe('decodeRichBody / forward LightApp', () => {
  it('emits {type:"forward", resId, forwardUuid} for com.tencent.multimsg', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            lightApp: {
              data: lightAppBytes({
                app: 'com.tencent.multimsg',
                meta: { detail: { resid: 'inner-res-1', uniseq: 'uuid-1' } },
              }),
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([{ type: 'forward', resId: 'inner-res-1', forwardUuid: 'uuid-1' }]);
  });

  it('omits forwardUuid when the sender did not set uniseq (XML-era forwards)', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            lightApp: {
              data: lightAppBytes({
                app: 'com.tencent.multimsg',
                meta: { detail: { resid: 'only-resid' } },
              }),
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toEqual([{ type: 'forward', resId: 'only-resid' }]);
  });

  it('falls back to {type:"json"} for non-multimsg LightApp (e.g. mini-app card)', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            lightApp: {
              data: lightAppBytes({ app: 'com.tencent.miniapp_01', meta: {} }),
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('json');
    expect(typeof (out[0] as any).text).toBe('string');
  });

  it('falls back to {type:"json"} when com.tencent.multimsg is missing resid (malformed)', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          {
            lightApp: {
              data: lightAppBytes({
                app: 'com.tencent.multimsg',
                meta: { detail: {} },
              }),
            },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('json');
  });

  it('still decodes the legacy richMsg serviceID=35 path (backward compat with mobile QQ)', () => {
    // Older clients (and some bridges) still emit the m_resid XML
    // shape. The decoder must keep treating it as a forward element
    // so SnowLuma can fetch the resid downstream.
    const xml = '<?xml version="1.0"?><msg m_resid="legacy-res" />';
    const xmlBuf = new Uint8Array(xml.length + 1);
    xmlBuf[0] = 0x00;
    xmlBuf.set(new TextEncoder().encode(xml), 1);

    const body: MessageBody = {
      richText: {
        elems: [
          {
            richMsg: { serviceId: 35, template1: xmlBuf },
          } as any,
        ],
      },
    };
    const out = decodeRichBody(body, true);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'forward', resId: 'legacy-res' });
  });
});
