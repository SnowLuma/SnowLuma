import { expect, it, vi } from 'vitest';

vi.mock('../../../package.json', () => ({ name: '@test/renamed-codec' }));

import protobufPlugin from '../../../src/index';
import { ProtobufCompiler } from '../../../src/compiler/compiler';
import { protobuf_encode } from '../../../src/runtime';

it('uses the manifest name for imports, plugin identity and diagnostics', () => {
    expect(protobufPlugin().name).toBe('@test/renamed-codec:vite');
    expect(
        new ProtobufCompiler().compile(
            `import {protobuf_encode} from '@test/renamed-codec';
    interface Msg {value:pb<1,uint_32>;} protobuf_encode<Msg>({value:7});`,
            'renamed.ts',
        ),
    ).toContain('protobuf_encode_Msg({value:7})');
    expect(() => protobuf_encode({})).toThrow('@test/renamed-codec Vite plugin');
    expect(() =>
        new ProtobufCompiler().compile(
            `import {protobuf_encode} from '@test/renamed-codec'; protobuf_encode<Missing>({});`,
            'error.ts',
        ),
    ).toThrow('[@test/renamed-codec]');
});
