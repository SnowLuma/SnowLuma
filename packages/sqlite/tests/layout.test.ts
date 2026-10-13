import { expect, it } from 'vitest';
import { assertRuntime, prebuildFiles, runtimeLibc, runtimePrebuild } from '../src/layout';

it('selects only the exact platform, architecture and libc binary', () => {
    expect(runtimePrebuild('win32', 'arm64')).toBe('win32-arm64/@appthreat+sqlite3.node');
    expect(runtimePrebuild('darwin', 'x64')).toBe('darwin-x64/@appthreat+sqlite3.node');
    expect(
        runtimePrebuild('linux', 'arm64', runtimeLibc({ header: { glibcVersionRuntime: '2.39' } })),
    ).toBe('linux-arm64/@appthreat+sqlite3.glibc.node');
    expect(runtimePrebuild('linux', 'x64', runtimeLibc({ header: {} }))).toBe(
        'linux-x64/@appthreat+sqlite3.musl.node',
    );
    expect(() => runtimePrebuild('linux', 'x64')).toThrow('libc');
    expect(() => prebuildFiles('linux-ia32')).toThrow('Unsupported SQLite target');
    expect(() => runtimeLibc({})).toThrow('diagnostic report');
});

it('rejects incompatible runtimes before attempting to load a Node-API 10 binary', () => {
    expect(() => assertRuntime('24.0.0', '10')).not.toThrow();
    expect(() => assertRuntime('26.0.0', '11')).not.toThrow();
    expect(() => assertRuntime('22.0.0', '10')).toThrow('Node >=24');
    expect(() => assertRuntime('24.0.0', '9')).toThrow('Node-API >=10');
    expect(() => assertRuntime('24.0.0', undefined)).toThrow('Node-API >=10');
});
