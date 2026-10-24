import type { MessageRegistry } from './model.js';

export function collectDependencyClosure(
    registry: MessageRegistry,
    roots: Iterable<string>,
): Set<string> {
    const selected = new Set<string>();

    function visit(name: string): void {
        if (selected.has(name)) {
            return;
        }

        const msg = registry.get(name);

        if (!msg) {
            return;
        }

        selected.add(name);

        for (const field of msg.fields) {
            if (registry.has(field.typeName)) {
                visit(field.typeName);
            }
        }
    }

    for (const root of roots) {
        visit(root);
    }

    return selected;
}
