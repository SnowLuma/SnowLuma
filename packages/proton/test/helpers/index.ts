import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Load a fixture file as a string. */
export function loadFixture(name: string): string {
    return readFileSync(resolve(fixturesDir, name), 'utf-8');
}
