import type { MessageRegistry, ProtobufField, ProtobufMessage } from './ast/types.js';

export type RuntimeMapFnName = 'protobuf_encode' | 'protobuf_decode';

export interface RuntimeMapCallSite {
  file: string;
  line: number;
  column: number;
  fnName: RuntimeMapFnName;
  typeName: string;
}

export interface ProtobufRuntimeMap {
  version: 1;
  messages: ProtobufMessage[];
  callSites: RuntimeMapCallSite[];
}

function cloneField(field: ProtobufField): ProtobufField {
  return {
    name: field.name,
    fieldNumber: field.fieldNumber,
    typeName: field.typeName,
    wireType: field.wireType,
    isMessage: field.isMessage,
    isOptional: field.isOptional,
    isRepeated: field.isRepeated,
    explicitPresence: field.explicitPresence ?? false,
  };
}

function cloneMessage(msg: ProtobufMessage): ProtobufMessage {
  return {
    name: msg.name,
    fields: msg.fields.map(cloneField),
  };
}

export function registryToRuntimeMapMessages(registry: MessageRegistry): ProtobufMessage[] {
  return [...registry.values()].map(cloneMessage);
}

export function runtimeMapToRegistry(map: ProtobufRuntimeMap): MessageRegistry {
  const registry: MessageRegistry = new Map();
  for (const msg of map.messages) {
    registry.set(msg.name, cloneMessage(msg));
  }
  return registry;
}

export function normalizeRuntimeMapPath(filePath: string): string {
  const noQuery = filePath.replace(/[?#].*$/, '');
  return noQuery.replace(/\\/g, '/').replace(/^file:\/\//, '');
}

export function createRuntimeMap(map: { messages: MessageRegistry; callSites: RuntimeMapCallSite[] }): ProtobufRuntimeMap {
  const dedupedCallSites = new Map<string, RuntimeMapCallSite>();
  for (const cs of map.callSites) {
    const normalized = {
      ...cs,
      file: normalizeRuntimeMapPath(cs.file),
    };
    const key = `${normalized.file}:${normalized.line}:${normalized.column}:${normalized.fnName}:${normalized.typeName}`;
    dedupedCallSites.set(key, normalized);
  }

  return {
    version: 1,
    messages: registryToRuntimeMapMessages(map.messages),
    callSites: [...dedupedCallSites.values()],
  };
}
