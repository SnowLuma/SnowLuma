import protobufVitePlugin from '@snowluma/proton/vite';
import fs from 'fs';
import { builtinModules } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, PluginOption, UserConfig } from 'vite';
import cp from 'vite-plugin-cp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const distDir = path.resolve(repoRoot, 'dist');
const runtimeDir = path.resolve(repoRoot, 'packages', 'runtime');
const nativeDir = path.resolve(runtimeDir, 'native');

// Single source of truth for the user-facing app version: monorepo root package.json.
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(repoRoot, 'package.json'), 'utf-8'),
) as { version: string };

// vite-plugin-cp consumes globs through globby; on Windows we must use POSIX-style separators.
const toPosix = (p: string) => p.replace(/\\/g, '/');

// `@snowluma/websocket` is bundled — it's an
// in-tree TS workspace wrapper that routes its native `.node`
// addon through `dist/native/`. Only Node builtins stay external.
//
// `node:sqlite` is an experimental builtin that Node 22.x lines don't
// list in `builtinModules`, so the `nodeModules` sweep below misses it.
// Externalise it explicitly — otherwise Vite bundles it and swaps in a
// browser shell, crashing the hook with `DatabaseSync is not a
// constructor` (the bug PR #68 set out to fix).
const external: string[] = ['node:sqlite', 'sqlite'];

const nodeModules = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)].flat();

const runtimeSrc = toPosix(runtimeDir);
const nativeSrc = toPosix(nativeDir);

// Target selection: `SNOWLUMA_TARGET=<platform>-<arch>` overrides the host
// detection, enabling cross-target packaging on CI.
const targetTriple = process.env.SNOWLUMA_TARGET ?? `${process.platform}-${process.arch}`;
const [targetPlatform, targetArch] = targetTriple.split('-');

// Runtime scaffolding files copied into dist/. The NTQQ hook is Windows-only,
// so its launcher/shell script differ per target.
const runtimeDistFiles = ['package.json',
  targetPlatform === 'win32' ? 'launcher.bat' : 'launcher.sh',
];

// Native binaries shipped for the selected target:
//   * `snowluma-*.{dll,node,so}`           – NTQQ hook (Windows + Linux).
//   * `websocket-*.node`                   – RFC 6455 framing/mask addon (all platforms).
const nativeFiles = [
  `websocket-${targetTriple}.node`,
  ...(targetPlatform === 'win32'
    ? [`snowluma-${targetTriple}.dll`, `snowluma-${targetTriple}.node`]
    : []),
  ...(targetPlatform === 'linux'
    ? [`snowluma-${targetTriple}.node`, `snowluma-${targetTriple}.so`]
    : []),
];

// FFmpeg native addon ported from NapCat. Uses NapCat's
// `<platform>.<arch>` naming so the prebuilt binaries can be vendored
// as-is without renaming. Lives under `native/ffmpeg/` to keep it
// separate from the SnowLuma flat-naming addons above.
const ffmpegAddonFile = `ffmpegAddon.${targetPlatform}.${targetArch}.node`;
const ffmpegSrcDir = path.resolve(nativeDir, 'ffmpeg');

// Fail fast if any expected native binary is missing from packages/runtime/native/.
// vite-plugin-cp only emits a warning on missing source files; we want a hard
// error so CI can't accidentally ship an incomplete archive.
const missingNatives = nativeFiles.filter(
  (f) => !fs.existsSync(path.join(nativeDir, f)),
);
if (!fs.existsSync(path.join(ffmpegSrcDir, ffmpegAddonFile))) {
  missingNatives.push(`ffmpeg/${ffmpegAddonFile}`);
}
if (missingNatives.length > 0) {
  throw new Error(
    `Missing native binaries for target ${targetTriple}:\n` +
    missingNatives.map((f) => `  - ${path.join(nativeDir, f)}`).join('\n'),
  );
}

const BaseConfigPlugin: PluginOption[] = [
  // Proton substitutes every `protobuf_encode<T>` / `protobuf_decode<T>`
  // call site with a monomorphized codec at build time. WITHOUT this
  // plugin in the plugins array the runtime fallback in
  // `@snowluma/proton/runtime.ts` throws on the first call (and the
  // packaged Win/Linux release does exactly that). It MUST appear
  // before `cp` so the transform runs on every source file Vite asks
  // for, regardless of where `cp` later copies emitted assets.
  protobufVitePlugin(),
  cp({
    targets: [
      ...runtimeDistFiles.map((file) => ({
        src: `${runtimeSrc}/${file}`,
        dest: distDir,
        flatten: true,
      })),
      ...nativeFiles.map((f) => ({
        src: `${nativeSrc}/${f}`,
        dest: path.join(distDir, 'native'),
        flatten: true,
      })),
      {
        src: `${toPosix(ffmpegSrcDir)}/${ffmpegAddonFile}`,
        dest: path.join(distDir, 'native', 'ffmpeg'),
        flatten: true,
      },
    ]
  })
];

const BaseConfig = (source_map: boolean = false) => defineConfig({
  resolve: {
    conditions: ['node', 'default'],
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  build: {
    sourcemap: source_map,
    target: 'esnext',
    minify: false,
    lib: {
      entry: {
        index: path.resolve(__dirname, 'src/index.ts')
      },
      formats: ['es'],
      fileName: (_, entryName) => `${entryName}.mjs`
    },
    rollupOptions: {
      external: [...nodeModules, ...external],
      output: {
        // better-sqlite3's JS wrapper is pure CJS — its `require('fs')` /
        // `require('path')` / `require('bindings')` calls get inlined into
        // the ESM bundle as `__require("fs")` shims by rolldown. Those
        // shims gate on `typeof require !== "undefined"`, which is true
        // in CJS but FALSE in our `.mjs` output, so they fall through to
        // a runtime `throw Error("Calling \`require\` ... in an environment
        // that doesn't expose the \`require\` function.")` on first call —
        // crashing the launcher immediately.
        //
        // Defining a module-scope `require` via `createRequire(import.meta.url)`
        // at the very top of the bundle satisfies the `typeof` check, and
        // the shim then transparently delegates every inlined CJS require
        // to the real CJS loader. Node 18+ ships `createRequire` in the
        // `node:module` builtin, so this is supported on every target.
        banner: [
          "import { createRequire as __snowlumaCreateRequire } from 'node:module';",
          "const require = __snowlumaCreateRequire(import.meta.url);",
        ].join('\n'),
      },
    },
    // Emit to monorepo root dist/ so the existing release pipeline keeps working.
    outDir: distDir,
    // Required since outDir is outside the vite project root.
    emptyOutDir: true
  },
  define: {
    __BUILD_WEBUI__: process.env.BUILD_WEBUI === 'true',
    __APP_VERSION__: JSON.stringify(rootPkg.version)
  }
});

export default defineConfig(({ mode }): UserConfig => {
  if (mode === 'development') {
    return {
      ...BaseConfig(true),
      plugins: [...BaseConfigPlugin]
    };
  }
  return {
    ...BaseConfig(),
    plugins: [...BaseConfigPlugin]
  };
});
