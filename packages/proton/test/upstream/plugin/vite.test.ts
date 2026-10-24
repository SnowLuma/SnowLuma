import { describe, expect, it } from 'vitest';
import protobufPlugin from '../../../src/index';
import { packageName } from '../../../src/package';
import { ProtobufCompiler } from '../../../src/compiler/compiler';
import { run, imports } from '../compile';
import { withProject } from '../project';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const schema = 'interface Msg { value: pb<1,uint_32>; }';

describe('plugin entry', () => {
    it('watches type-only dependencies and rebuilds importers after schema changes', async () => {
        await withProject(
            { 'message.ts': 'export interface Msg { value: pb<1, uint_32>; }' },
            (directory) => {
                const plugin = protobufPlugin();
                const transformHook = plugin.transform!;
                const transform =
                    typeof transformHook === 'function' ? transformHook : transformHook.handler;
                const dependencies: string[] = [];
                const context = { addWatchFile: (path: string) => dependencies.push(path) } as any;
                const file = join(directory, 'entry.ts').replaceAll('\\', '/');
                const message = join(directory, 'message.ts').replaceAll('\\', '/');
                const source = `${imports} import type { Msg } from './message'; protobuf_encode<Msg>({value:7});`;
                const initial = transform.call(context, source, file) as { code: string };
                expect(initial.code).toContain('buf[offset++] = 8;');
                expect(dependencies).toContain(message);
                writeFileSync(message, 'export interface Msg { value: pb<2, uint_32>; }');
                const updateHook = plugin.handleHotUpdate!;
                const update = typeof updateHook === 'function' ? updateHook : updateHook.handler;
                const module = { id: file };
                expect(
                    update.call(
                        {} as any,
                        {
                            file: message,
                            server: {
                                moduleGraph: {
                                    getModuleById: (id: string) =>
                                        id === file ? module : undefined,
                                },
                            },
                        } as any,
                    ),
                ).toEqual([module]);
                const updated = transform.call(context, source, file) as { code: string };
                expect(updated.code).toContain('buf[offset++] = 16;');
            },
        );
    });

    it('recognizes the package name from package.json', () => {
        const plugin = protobufPlugin();
        const hook = plugin.transform!;
        const transform = typeof hook === 'function' ? hook : hook.handler;
        const result = transform.call(
            {} as any,
            `import {protobuf_encode as encode} from '${packageName}'; ${schema} encode<Msg>({value:7});`,
            'entry.ts',
        ) as { code: string };
        expect(result.code).toContain('protobuf_encode_Msg({value:7})');
    });

    it('leaves unrelated modules and declaration files alone', () => {
        const plugin = protobufPlugin();
        const hook = plugin.transform!;
        const transform = typeof hook === 'function' ? hook : hook.handler;

        for (const file of ['entry.js', 'schema.d.ts', 'schema.d.mts']) {
            expect(transform.call({} as any, schema, file)).toBeNull();
        }

        expect(new ProtobufCompiler().compile(schema, 'schema.ts')).toBeNull();
    });

    it('generates only codecs reachable from actual calls', () => {
        const code = new ProtobufCompiler().compile(
            `import {protobuf_encode} from '${packageName}'; ${schema}
      interface Unused {value:pb<1,Missing>;}
      protobuf_encode<Msg>({value:7});`,
            'used.ts',
        )!;
        expect(code).not.toContain('function protobuf_decode_');
        expect(code).not.toContain('function protobuf_encode_Unused');
        expect(code).toContain('function protobuf_encode_Msg');
    });

    it('reports unresolved types instead of leaving runtime calls behind', () => {
        expect(() => run('protobuf_encode<Missing>({});')).toThrow(/Unresolved type Missing/);
    });

    it('fails clearly when the build plugin is absent', async () => {
        const runtime = await import('../../../src/runtime');
        expect(Object.keys(runtime).sort()).toEqual([
            'protobuf_decode',
            'protobuf_encode',
            'protobuf_getUnknownFieldMetadata',
            'protobuf_getUnknownFields',
        ]);
        expect(() => runtime.protobuf_encode({})).toThrow(
            `not transformed by the ${packageName} Vite plugin`,
        );
        expect(() => runtime.protobuf_decode(new Uint8Array())).toThrow(
            `not transformed by the ${packageName} Vite plugin`,
        );
    });
});
