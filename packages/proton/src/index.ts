import type { Plugin, ResolvedConfig } from 'vite';
import { ProtobufCompiler } from './compiler/compiler.js';
import { buildEntries } from './source/entries.js';
import { packageName } from './package.js';

export default function protobufVitePlugin(): Plugin {
    const compiler = new ProtobufCompiler();
    const transformedFiles = new Set<string>();
    let config: ResolvedConfig | undefined;
    let needsPreparation = true;

    const invalidate = () => {
        compiler.clear();
        needsPreparation = true;
    };

    return {
        name: `${packageName}:vite`,
        enforce: 'pre',

        configResolved(resolved) {
            config = resolved;
        },

        buildStart() {
            invalidate();
            transformedFiles.clear();
        },

        watchChange() {
            invalidate();
        },

        transform(code, id) {
            const cleanId = id.split('?')[0];

            if (!/\.[cm]?tsx?$/.test(cleanId) || /\.d\.[cm]?ts$/.test(cleanId)) {
                return null;
            }

            if (needsPreparation) {
                if (config) {
                    compiler.prepare(buildEntries(config));
                }

                needsPreparation = false;
            }

            const transformed = compiler.compile(code, cleanId);

            if (transformed !== null) {
                transformedFiles.add(cleanId);

                for (const dependency of compiler.context.files.keys()) {
                    this.addWatchFile?.(dependency);
                }
            }

            return transformed === null ? null : { code: transformed, map: null };
        },

        handleHotUpdate({ file, server }) {
            if (/\.[cm]?tsx?$/.test(file)) {
                invalidate();
                return [...transformedFiles].flatMap((id) => {
                    const module = server.moduleGraph.getModuleById(id);
                    return module ? [module] : [];
                });
            }

            return;
        },
    };
}
