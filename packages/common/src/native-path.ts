import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveRuntimeNativePath(fileName: string): string | null {
    // Bundled releases and workspace sources each own their native inputs.
    for (const directory of [
        path.join(moduleDir, 'native'),
        path.resolve(moduleDir, '..', '..', 'runtime', 'native'),
    ]) {
        const candidate = path.join(directory, fileName);

        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}
