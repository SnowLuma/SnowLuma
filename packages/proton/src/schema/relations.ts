import type { TypeValue } from './types.js';

export function assignable(
    source: TypeValue,
    target: TypeValue,
    seen = new Set<string>(),
): boolean {
    if (
        source.key === target.key ||
        target.name === 'unknown' ||
        target.name === 'any' ||
        source.name === 'never'
    ) {
        return true;
    }

    if (target.name === 'object') {
        return (
            !!source.fields ||
            ['array', 'tuple', 'function', 'constructor', 'promise'].includes(source.kind)
        );
    }

    const key = `${source.key}:${target.key}`;

    if (seen.has(key)) {
        return true;
    }

    seen.add(key);

    if (source.kind === 'marker') {
        return assignable(source.values![0], target, seen);
    }

    if (target.kind === 'marker') {
        return assignable(source, target.values![0], seen);
    }

    if (source.kind === 'union') {
        return source.values!.every((type) => assignable(type, target, new Set(seen)));
    }

    if (target.kind === 'union') {
        return target.values!.some((type) => assignable(source, type, new Set(seen)));
    }

    if (source.kind === target.kind && source.values && target.values) {
        return (
            source.values.length === target.values.length &&
            source.values.every((type, index) => assignable(type, target.values![index], seen))
        );
    }

    if (source.fields && target.fields) {
        return [...target.fields].every(([name, field]) => {
            const actual = source.fields!.get(name);
            return actual
                ? (field.optional || !actual.optional) && assignable(actual.type, field.type, seen)
                : field.optional;
        });
    }

    if (target.kind === 'primitive' && source.kind === 'literal') {
        return target.name === 'string'
            ? /^["']/.test(source.key)
            : target.name === 'number'
              ? !Number.isNaN(Number(source.name))
              : target.name === 'bool' && /^(true|false)$/.test(source.name);
    }

    if (target.name === 'number') {
        return /^(?:u?int_32|sint_32|s?fixed_32|float|double)$/.test(source.name);
    }

    if (target.name === 'bigint') {
        return /^(?:u?int_64|sint_64|s?fixed_64)$/.test(source.name);
    }

    return false;
}

export function matchInferred(
    source: TypeValue,
    pattern: TypeValue,
    inferred: Map<string, TypeValue>,
    seen = new Set<string>(),
): boolean {
    if (pattern.kind === 'inference') {
        const previous = inferred.get(pattern.name);

        if (previous && previous.key !== source.key) {
            return false;
        }

        inferred.set(pattern.name, source);
        return true;
    }

    const key = `${source.key}:${pattern.key}`;

    if (seen.has(key)) {
        return true;
    }

    seen.add(key);

    if (source.kind === 'function' && pattern.kind === 'function') {
        const args = pattern.values![0].values!;
        const variadicAny =
            args.length === 1 && args[0].kind === 'array' && args[0].values![0].name === 'any';
        return (
            (variadicAny || matchInferred(source.values![0], pattern.values![0], inferred, seen)) &&
            matchInferred(source.values![1], pattern.values![1], inferred, seen)
        );
    }

    if (source.fields && pattern.fields) {
        return [...pattern.fields].every(([name, property]) => {
            const actual = source.fields!.get(name);
            return actual
                ? matchInferred(actual.type, property.type, inferred, seen)
                : property.optional;
        });
    }

    if (source.kind === pattern.kind && source.values && pattern.values) {
        return (
            source.values.length === pattern.values.length &&
            source.values.every((type, index) =>
                matchInferred(type, pattern.values![index], inferred, seen),
            )
        );
    }

    return assignable(source, pattern);
}
