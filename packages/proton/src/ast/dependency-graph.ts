import type { MessageRegistry } from './types.js';

export function collectDependencyClosure(registry: MessageRegistry, roots: Iterable<string>): Set<string> {
  const selected = new Set<string>();

  function visit(name: string): void {
    if (selected.has(name)) return;
    const msg = registry.get(name);
    if (!msg) return;

    selected.add(name);
    for (const field of msg.fields) {
      if (registry.has(field.typeName)) visit(field.typeName);
    }
  }

  for (const root of roots) visit(root);
  return selected;
}

export function pickRegistrySubset(registry: MessageRegistry, selectedNames: Set<string>): MessageRegistry {
  const subset: MessageRegistry = new Map();
  for (const [name, msg] of registry) {
    if (selectedNames.has(name)) subset.set(name, msg);
  }
  return subset;
}

export function buildDependencyRegistry(registry: MessageRegistry, roots: Iterable<string>): MessageRegistry {
  const selected = collectDependencyClosure(registry, roots);
  return pickRegistrySubset(registry, selected);
}
