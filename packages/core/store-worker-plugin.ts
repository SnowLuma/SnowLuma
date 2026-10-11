import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, type Plugin, type Rollup } from 'vite';

export async function bundleStoreWorker(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      copyPublicDir: false,
      target: 'node22',
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('./src/sqlite-store-worker.ts', import.meta.url)),
        formats: ['cjs'],
        fileName: 'sqlite-store-worker',
      },
      rollupOptions: {
        external: [...builtinModules, ...builtinModules.map(name => `node:${name}`), 'node:sqlite'],
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  const entry = outputs.flatMap(output => output.output).find(output => output.type === 'chunk' && output.isEntry);
  if (!entry || entry.type !== 'chunk') throw new Error('SQLite store worker bundle is missing');
  return entry.code;
}

export function storeWorkerPlugin(): Plugin {
  return {
    name: 'sqlite-store-worker',
    async config() {
      return { define: { __SQLITE_STORE_WORKER__: JSON.stringify(await bundleStoreWorker()) } };
    },
  };
}
