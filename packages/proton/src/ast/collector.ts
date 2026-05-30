import ts from 'typescript';
import {
  WireType,
  PB_MARKER, PB_REPEATED_MARKER, PB_OPTIONAL_MARKER,
  type ProtobufField, type ProtobufMessage,
  type GenericProtobufTemplate, type GenericFieldTemplate,
} from './types.js';
import { isKeywordTypeNode, typeNodeToMangledName, type ImportedTypeNameResolver } from './utils.js';

function identityImportedTypeName(name: string): string {
  return name;
}

/**
 * Yield generic-instantiated type-arg nodes appearing as field types on a
 * **concrete** (non-generic) interface — e.g. `wrapped: pb<5, Wrapper<uint_32>>`
 * yields the `Wrapper<uint_32>` node so the analyzer can enqueue it for
 * monomorphization. (The call-site-driven queue only sees the outer concrete
 * type; nested generic instantiations on its fields would otherwise be missed.)
 */
export function* collectConcreteFieldGenericTypeArgs(
  node: ts.InterfaceDeclaration,
  resolveImportedTypeName: ImportedTypeNameResolver = identityImportedTypeName,
): IterableIterator<ts.TypeNode> {
  if (node.typeParameters?.length) return;
  for (const m of node.members) {
    if (!ts.isPropertySignature(m) || !m.type) continue;
    const parsed = parsePbTypeRef(m, resolveImportedTypeName);
    if (!parsed) continue;
    const ta = parsed.typeArgNode;
    if (ts.isTypeReferenceNode(ta) && ta.typeArguments && ta.typeArguments.length > 0) {
      yield ta;
    }
  }
}

/** Collect a concrete (non-generic) interface with pb<>/pb_repeated<> fields. */
export function collectInterface(
  node: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  resolveImportedTypeName: ImportedTypeNameResolver = identityImportedTypeName,
): ProtobufMessage | null {
  const fields: ProtobufField[] = [];
  for (const m of node.members) {
    if (!ts.isPropertySignature(m) || !m.type) continue;
    const f = extractField(m, sf, resolveImportedTypeName);
    if (f) fields.push(f);
  }
  // Register interfaces that are EXPLICITLY empty (`interface X {}`) as
  // zero-field proto messages — proto3 wire format allows them and
  // downstream code routinely uses them for "this OIDB call has no
  // meaningful response body" placeholders. Interfaces that have
  // members but no pb-marked fields are NOT proto messages — they
  // belong to regular TS types and must stay unregistered to avoid
  // polluting the registry.
  if (fields.length === 0 && node.members.length > 0) return null;
  return { name: node.name.text, fields };
}

/** Collect a generic interface template. */
export function collectGenericInterface(
  node: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  resolveImportedTypeName: ImportedTypeNameResolver = identityImportedTypeName,
): GenericProtobufTemplate | null {
  const typeParams = node.typeParameters!.map(p => p.name.text);
  const tpSet = new Set(typeParams);
  const fields: GenericFieldTemplate[] = [];
  for (const m of node.members) {
    if (!ts.isPropertySignature(m) || !m.type) continue;
    const f = extractGenericField(m, sf, tpSet, resolveImportedTypeName);
    if (f) fields.push(f);
  }
  return fields.length ? { name: node.name.text, typeParams, fields } : null;
}

// ── helpers ───────────────────────────────────────────────────────────

function parsePbTypeRef(
  member: ts.PropertySignature,
  resolveImportedTypeName: ImportedTypeNameResolver = identityImportedTypeName,
): { marker: string; fieldNumber: number; typeArgNode: ts.TypeNode } | null {
  const t = member.type!;
  if (!ts.isTypeReferenceNode(t) || !ts.isIdentifier(t.typeName)) return null;
  // Resolve the marker name through aliased imports so `import { pb as P }`
  // / `import { pb_repeated as PR }` still match the marker constants.
  const marker = resolveImportedTypeName(t.typeName.text);
  if (marker !== PB_MARKER && marker !== PB_REPEATED_MARKER && marker !== PB_OPTIONAL_MARKER) return null;
  const ta = t.typeArguments;
  if (!ta || ta.length !== 2) return null;
  const fnNode = ta[0];
  if (!ts.isLiteralTypeNode(fnNode) || !ts.isNumericLiteral(fnNode.literal)) return null;
  return { marker, fieldNumber: Number(fnNode.literal.text), typeArgNode: ta[1] };
}

function resolveTypeName(
  node: ts.TypeNode,
  sf: ts.SourceFile,
  resolveImportedTypeName: ImportedTypeNameResolver,
): string | null {
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
    // Generic instantiations (e.g. `Wrapper<uint_32>`) must resolve to the
    // mangled name produced by monomorphization so wire-type resolution can
    // find the message in the registry. Without this the field would carry
    // the bare identifier `"Wrapper"` and never link to `Wrapper__uint_32`.
    if (node.typeArguments && node.typeArguments.length > 0) {
      return typeNodeToMangledName(node, sf, resolveImportedTypeName);
    }
    return resolveImportedTypeName(node.typeName.text);
  }
  if (isKeywordTypeNode(node)) return node.getText(sf);
  return null;
}

function extractField(
  member: ts.PropertySignature,
  sf: ts.SourceFile,
  resolveImportedTypeName: ImportedTypeNameResolver,
): ProtobufField | null {
  const parsed = parsePbTypeRef(member, resolveImportedTypeName);
  if (!parsed) return null;
  const typeName = resolveTypeName(parsed.typeArgNode, sf, resolveImportedTypeName);
  if (!typeName || !ts.isIdentifier(member.name)) return null;
  return {
    name: (member.name as ts.Identifier).text,
    fieldNumber: parsed.fieldNumber,
    typeName,
    wireType: WireType.Varint,   // placeholder
    isMessage: false,             // placeholder
    isOptional: member.questionToken != null,
    isRepeated: parsed.marker === PB_REPEATED_MARKER,
    explicitPresence: parsed.marker === PB_OPTIONAL_MARKER,
  };
}

function extractGenericField(
  member: ts.PropertySignature,
  sf: ts.SourceFile,
  tpSet: Set<string>,
  resolveImportedTypeName: ImportedTypeNameResolver,
): GenericFieldTemplate | null {
  const parsed = parsePbTypeRef(member, resolveImportedTypeName);
  if (!parsed) return null;
  const raw = resolveTypeName(parsed.typeArgNode, sf, resolveImportedTypeName);
  if (!raw || !ts.isIdentifier(member.name)) return null;
  const result: GenericFieldTemplate = {
    name: (member.name as ts.Identifier).text,
    fieldNumber: parsed.fieldNumber,
    rawTypeName: tpSet.has(raw) ? raw : resolveImportedTypeName(raw),
    isTypeParam: tpSet.has(raw),
    isOptional: member.questionToken != null,
    isRepeated: parsed.marker === PB_REPEATED_MARKER,
    explicitPresence: parsed.marker === PB_OPTIONAL_MARKER,
  };
    // If the field's type-arg is itself a generic instantiation (`Wrapper<U>`,
    // where U is a type param of the enclosing template), capture the original
    // source text so monomorphization can substitute U and re-instantiate the
    // inner generic. Without this the field's `rawTypeName` would stay at the
    // unsubstituted `'Wrapper__U'` form and the substituted instantiation
    // would never reach the registry.
  const ta = parsed.typeArgNode;
  if (ts.isTypeReferenceNode(ta) && ta.typeArguments && ta.typeArguments.length > 0) {
    result.genericTypeArgText = ta.getText(sf);
    result.genericTypeArgSourceFilePath = sf.fileName;
  }
  return result;
}
