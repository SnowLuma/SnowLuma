import { afterEach, describe, expect, it } from 'vitest';
import { analyzeSource } from '../../src/ast/analyzer';
import { createRuntimeMap } from '../../src/runtime-map';
import {
  protobuf_decode,
  protobuf_disableRuntimeMapFallback,
  protobuf_enableRuntimeMapFallback,
  protobuf_encode,
} from '../../src/runtime';

function captureFrameFromThrow(fn: () => unknown, sourceFile: string): { line: number; column: number } {
  try {
    fn();
  } catch (err) {
    const stack = err instanceof Error ? err.stack ?? '' : '';
    for (const raw of stack.split('\n')) {
      const line = raw.trim();
      if (!line.includes(sourceFile)) continue;

      const location = line.endsWith(')') && line.includes('(')
        ? line.slice(line.lastIndexOf('(') + 1, -1)
        : line.replace(/^at\s+/, '');

      const lastColon = location.lastIndexOf(':');
      const secondLastColon = location.lastIndexOf(':', lastColon - 1);
      if (lastColon < 0 || secondLastColon < 0) continue;

      const parsedLine = Number(location.slice(secondLastColon + 1, lastColon));
      const parsedColumn = Number(location.slice(lastColon + 1));
      if (Number.isFinite(parsedLine) && Number.isFinite(parsedColumn)) {
        return { line: parsedLine, column: parsedColumn };
      }
    }
  }

  throw new Error(`Unable to capture stack frame for ${sourceFile}`);
}

function invokeEncode(): Uint8Array {
  return new Function(
    'protobuf_encode',
    `\n//# sourceURL=runtime-map-encode.js\nreturn protobuf_encode({ value: 7 });`,
  )(protobuf_encode) as Uint8Array;
}

function invokeDecode(data: Uint8Array): any {
  return new Function(
    'protobuf_decode',
    'data',
    `\n//# sourceURL=runtime-map-decode.js\nreturn protobuf_decode(data);`,
  )(protobuf_decode, data);
}

describe('runtime map fallback', () => {
  afterEach(() => {
    protobuf_disableRuntimeMapFallback();
  });

  it('dynamically generates encode/decode from runtime map when enabled', () => {
    const schema = `
interface SimpleMsg {
  value: pb<1, uint_32>;
}
`;
    const registry = analyzeSource(schema, 'schema.ts');

    const encodeFrame = captureFrameFromThrow(invokeEncode, 'runtime-map-encode.js');
    const decodeFrame = captureFrameFromThrow(() => invokeDecode(new Uint8Array([0x08, 0x07])), 'runtime-map-decode.js');

    const runtimeMap = createRuntimeMap({
      messages: registry,
      callSites: [
        {
          file: 'runtime-map-encode.js',
          line: encodeFrame.line,
          column: encodeFrame.column,
          fnName: 'protobuf_encode',
          typeName: 'SimpleMsg',
        },
        {
          file: 'runtime-map-decode.js',
          line: decodeFrame.line,
          column: decodeFrame.column,
          fnName: 'protobuf_decode',
          typeName: 'SimpleMsg',
        },
      ],
    });

    protobuf_enableRuntimeMapFallback(runtimeMap);

    const encoded = invokeEncode();
    expect([...encoded]).toEqual([0x08, 0x07]);

    const decoded = invokeDecode(encoded);
    expect(decoded.value).toBe(7);
  });
});
