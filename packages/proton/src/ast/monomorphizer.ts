import ts from 'typescript';
import { WireType, type ProtobufField, type ProtobufMessage, type GenericProtobufTemplate } from './types.js';
import {
  isKeywordTypeNode,
  createImportedTypeNameResolver,
  resolveSourceFileForTypeNode,
  type ImportedTypeNameResolver,
  typeNodeToMangledName,
} from './utils.js';

function identityImportedTypeName(name: string): string {
  return name;
}

/** Resolved value for a single template type parameter. */
interface ResolvedTypeArg {
    /** Mangled-name form used when substituting into a `rawTypeName` slot
     *  for an `isTypeParam` field. */
    mangled: string;
    /** Original TypeScript source text — used when re-substituting into a
     *  field's `genericTypeArgText` so the substituted text remains parseable. */
    text: string;
}

/**
 * Recursively monomorphize a generic type instantiation into concrete ProtobufMessages.
 * E.g. `Wrapper<Wrapper<string>>` → creates `Wrapper__string` and `Wrapper__Wrapper__string`.
 * Returns the mangled name of the concrete type, or null if it cannot be resolved.
 */
export function monomorphizeTypeNode(
  typeNode: ts.TypeNode,
  sf: ts.SourceFile,
  templates: Map<string, GenericProtobufTemplate>,
  out: Map<string, ProtobufMessage>,
  resolveImportedTypeName: ImportedTypeNameResolver = identityImportedTypeName,
): string | null {
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return null;

  const baseName = resolveImportedTypeName(typeNode.typeName.text);
  const typeArgs = typeNode.typeArguments;
  if (!typeArgs || typeArgs.length === 0) return baseName; // already concrete

  const tpl = templates.get(baseName);
  if (!tpl || typeArgs.length !== tpl.typeParams.length) return null;

  const mangledName = typeNodeToMangledName(typeNode, sf, resolveImportedTypeName);
  if (out.has(mangledName)) return mangledName; // already done

  // Resolve each type parameter → both mangled name AND source text.
  const paramMap = new Map<string, ResolvedTypeArg>();
  for (let i = 0; i < tpl.typeParams.length; i++) {
    const resolved = resolveTypeArg(typeArgs[i], sf, templates, out, resolveImportedTypeName);
    if (!resolved) return null;
    paramMap.set(tpl.typeParams[i], resolved);
  }

  // Substitute type params in template fields.
  const fields: ProtobufField[] = tpl.fields.map(f => {
    if (f.genericTypeArgText) {
      // Field type is an inner generic instantiation referencing template
      // type params (e.g. `pb<N, Wrapper<U>>`). Substitute the params into
      // the captured text, re-parse, and re-monomorphize so the resulting
      // concrete instantiation (`Wrapper<uint_32>`) lands in `out`.
      let substituted = f.genericTypeArgText;
      for (const [paramName, value] of paramMap) {
        substituted = substituted.replace(
          new RegExp(`\\b${paramName}\\b`, 'g'),
          value.text,
        );
      }
      const innerSfPath = f.genericTypeArgSourceFilePath ?? sf.fileName;
      const innerSf = ts.createSourceFile(
        innerSfPath,
        `type __X = ${substituted};`,
        ts.ScriptTarget.Latest,
        true,
      );
      const stmt = innerSf.statements[0];
      let resolvedTypeName: string | null = null;
      if (ts.isTypeAliasDeclaration(stmt)) {
        const innerResolver = createImportedTypeNameResolver(innerSf);
        resolvedTypeName = monomorphizeTypeNode(stmt.type, innerSf, templates, out, innerResolver);
      }
      return {
        name: f.name,
        fieldNumber: f.fieldNumber,
        typeName: resolvedTypeName ?? f.rawTypeName,
        wireType: WireType.Varint,
        isMessage: false,
        isOptional: f.isOptional,
        isRepeated: f.isRepeated,
        explicitPresence: f.explicitPresence,
      };
    }
    return {
      name: f.name,
      fieldNumber: f.fieldNumber,
      typeName: f.isTypeParam ? (paramMap.get(f.rawTypeName)?.mangled ?? f.rawTypeName) : f.rawTypeName,
      wireType: WireType.Varint,
      isMessage: false,
      isOptional: f.isOptional,
      isRepeated: f.isRepeated,
      explicitPresence: f.explicitPresence,
    };
  });

  out.set(mangledName, { name: mangledName, fields });
  return mangledName;
}

function resolveTypeArg(
  node: ts.TypeNode,
  sf: ts.SourceFile,
  templates: Map<string, GenericProtobufTemplate>,
  out: Map<string, ProtobufMessage>,
  resolveImportedTypeName: ImportedTypeNameResolver,
): ResolvedTypeArg | null {
  const effectiveSf = resolveSourceFileForTypeNode(node, sf);
  // Try recursive monomorphization first (handles nested generics).
  const mono = monomorphizeTypeNode(node, effectiveSf, templates, out, resolveImportedTypeName);
  if (mono) return { mangled: mono, text: node.getText(effectiveSf) };
  // Keyword type (string, number, …)
  if (isKeywordTypeNode(node)) {
    const text = node.getText(effectiveSf);
    return { mangled: text, text };
  }
  // Simple identifier (uint_32, SomeMsg, …)
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments) {
    const name = resolveImportedTypeName(node.typeName.text);
    return { mangled: name, text: name };
  }
  return null;
}
