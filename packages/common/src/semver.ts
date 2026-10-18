import parse from 'semver/functions/parse.js';

/** Parse a canonical SemVer string; tag prefixes belong at the GitHub boundary. */
export function parseVersion(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }

    const parsed = parse(value);

    if (!parsed) {
        return null;
    }

    const canonical = parsed.version + (parsed.build.length ? `+${parsed.build.join('.')}` : '');
    return value === canonical ? parsed : null;
}

export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);

    if (!left || !right) {
        throw new TypeError('Invalid semantic version');
    }

    return left.compare(right);
}
