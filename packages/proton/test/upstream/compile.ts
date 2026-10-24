import ts from 'typescript';
import { ProtobufCompiler } from '../../src/compiler/compiler';
import { packageName } from '../../src/package';

export const imports = `import { protobuf_encode, protobuf_decode } from '${packageName}';`;

export function run(body: string): any {
    const compiler = new ProtobufCompiler();
    const source = imports + '\n' + body;
    const transformed = compiler.compile(source, 'test-entry.ts') ?? source;
    const js = ts.transpileModule(transformed, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    new Function('exports', 'require', js)(exports, () => ({
        protobuf_encode() {
            throw new Error('Uncompiled encode');
        },
        protobuf_decode() {
            throw new Error('Uncompiled decode');
        },
    }));
    return exports;
}
