import ts from 'typescript';
import type { Edit, Site } from './model.js';

export function unique(source: ts.SourceFile, base: string): string {
    while (source.text.includes(base)) {
        base += '_';
    }

    return base;
}

export function codecIndex(params: readonly ts.ParameterDeclaration[] = []): number {
    const index = params.findIndex((param) => !!param.initializer || !!param.dotDotDotToken);
    return index < 0 ? params.length : index;
}

export function insertParameters(
    params: ts.NodeArray<ts.ParameterDeclaration>,
    names: string[],
    edits: Edit[],
    source: ts.SourceFile,
): void {
    names = names.map((name) => name + ' = undefined');
    const index = codecIndex(params);

    if (index < params.length) {
        edits.push({
            start: params[index].getStart(source),
            end: params[index].getStart(source),
            text: names.join(', ') + ', ',
        });
    } else {
        edits.push({
            start: params.end,
            end: params.end,
            text: (params.length && !params.hasTrailingComma ? ', ' : '') + names.join(', '),
        });
    }
}

export function insertArguments(
    node: Site['node'],
    params: readonly ts.ParameterDeclaration[] | undefined,
    args: string[],
    edits: Edit[],
    source: ts.SourceFile,
): void {
    const index = codecIndex(params);
    const actual = node.arguments;

    if (actual?.some(ts.isSpreadElement)) {
        const values = unique(source, '__pb_arguments');
        edits.push({
            start: actual[0].getStart(source),
            end: actual[0].getStart(source),
            text: `...((${values}) => { while (${values}.length < ${index}) ${values}.push(undefined); ${values}.splice(${index}, 0, ${args.join(', ')}); return ${values}; })([`,
        });
        edits.push({ start: actual.end, end: actual.end, text: '])', order: 1 });
        return;
    }

    const missing = Math.max(0, index - (actual?.length ?? 0));
    const text = [...Array(missing).fill('undefined'), ...args].join(', ');

    if (!actual) {
        edits.push({ start: node.end, end: node.end, text: `(${text})` });
    } else if (actual.length > index) {
        edits.push({
            start: actual[index].getStart(source),
            end: actual[index].getStart(source),
            text: text + ', ',
        });
    } else {
        edits.push({
            start: actual.end,
            end: actual.end,
            text: (actual.length && !actual.hasTrailingComma ? ', ' : '') + text,
        });
    }
}
