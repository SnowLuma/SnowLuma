import ts from 'typescript';
import { getCallableName } from './ast-helpers.js';
import {
  collectProtobufImportBindings,
  matchProtobufCallSite,
  type CanonicalProtobufFn,
} from './callsite.js';
import { collectConcreteFieldGenericTypeArgs, collectGenericInterface, collectInterface } from './collector.js';
import { buildDependencyRegistry } from './dependency-graph.js';
import type { ImportedDefinitions, WrapperBinding } from './import-resolver.js';
import { monomorphizeTypeNode } from './monomorphizer.js';
import { PRIMITIVE_TYPE_MAP, WireType, type GenericProtobufTemplate, type MessageRegistry, type ProtobufMessage } from './types.js';
import {
  createImportedTypeNameResolver,
  registerSyntheticTypeSourceFile,
  resolveSourceFileForTypeNode,
  typeNodeToMangledName,
} from './utils.js';

export { typeNodeToMangledName } from './utils.js';

function instantiateWrapperTypePattern(
  binding: WrapperBinding,
  callerTypeArgs: ts.NodeArray<ts.TypeNode>,
  sf: ts.SourceFile,
): ts.TypeNode | null {
  if (!binding.typePattern || !binding.typeParamNames?.length) return callerTypeArgs[binding.typeArgIndex] ?? null;

  let text = binding.typePattern;
  for (let i = 0; i < binding.typeParamNames.length; i++) {
    const arg = callerTypeArgs[i];
    if (!arg) return null;
    text = text.replace(new RegExp(`\\b${binding.typeParamNames[i]}\\b`, 'g'), arg.getText(sf));
  }

  // Parse the substituted type pattern into a fresh source file whose
  // `fileName` is the binding's origin (so subsequent import resolution can
  // find the right module) AND whose `text` contains the substituted source
  // (so `getText()` on the resulting TypeNode returns the actual type, not
  // garbage from an empty-text companion file).
  const parsed = ts.createSourceFile(
    binding.sourceFilePath ?? sf.fileName,
    `type __T = ${text};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const stmt = parsed.statements[0];
  if (!ts.isTypeAliasDeclaration(stmt)) return null;
  registerSyntheticTypeSourceFile(stmt.type, parsed);
  return stmt.type;
}

/** A recorded call-site for later replacement. */
export interface CallSiteRecord {
  fnName: CanonicalProtobufFn;
  exprStart: number;         // position of identifier start
  typeArgsEnd: number;       // position after closing '>'
  firstTypeArg: ts.TypeNode; // the type argument node
  line: number;              // 1-based line for runtime map lookup
  column: number;            // 1-based column for runtime map lookup
}

export interface ResolvedCallSiteRecord extends CallSiteRecord {
  typeName: string;
}

export interface AnalysisResult {
  registry: MessageRegistry;
  callSites: CallSiteRecord[];
  sourceFile: ts.SourceFile;
}

export interface UsedRegistryResult {
  registry: MessageRegistry;
  roots: Set<string>;
  callSites: ResolvedCallSiteRecord[];
}

/**
 * Analyze TypeScript source in a **single parse + single walk**.
 *
 * One walk handles both:
 *  - Collecting concrete + generic interfaces
 *  - Recording protobuf_encode/decode call-sites
 *
 * Then post-processes: monomorphize → resolve wire types → topo sort.
 */
export function analyze(code: string, filePath: string, imported?: ImportedDefinitions): AnalysisResult {
  const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  const concrete: ProtobufMessage[] = [];
  const templates = new Map<string, GenericProtobufTemplate>();
  const mono = new Map<string, ProtobufMessage>();
  const callSites: CallSiteRecord[] = [];
  const deferredTypeArgs: ts.TypeNode[] = [];
  const importBindings = collectProtobufImportBindings(sf);
  const resolveImportedTypeName = createImportedTypeNameResolver(sf);
  const wrapperBindings = imported?.wrapperBindings ?? new Map<string, WrapperBinding>();

  // Seed with imported definitions
  if (imported) {
    concrete.push(...imported.concrete);
    for (const [k, v] of imported.templates) templates.set(k, v);
  }

  // Stack of generic-function type-param scopes. When visiting a
  // `protobuf_encode/decode<X>` call whose type arg references one of
  // these (e.g. `protobuf_encode<OidbBase<T>>(env)` inside
  // `function encodeOidbEnv<T>(...)`), we MUST skip monomorphization —
  // the type arg only resolves once the wrapper itself is instantiated
  // at a downstream call site, and that case is handled separately by
  // the wrapper-binding path in `matchForwardedProtobufFn`. Without
  // this skip, the analyzer would happily mint a literal `OidbBase__T`
  // registry entry with a `body.typeName = 'T'` field, which the
  // wire-type guard then trips on.
  const enclosingTypeParamStack: Set<string>[] = [];
  function typeArgReferencesEnclosingParam(typeArg: ts.TypeNode): boolean {
    if (enclosingTypeParamStack.length === 0) return false;
    let found = false;
    function check(n: ts.Node): void {
      if (found) return;
      if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
        const name = n.typeName.text;
        for (const scope of enclosingTypeParamStack) {
          if (scope.has(name)) { found = true; return; }
        }
      }
      ts.forEachChild(n, check);
    }
    check(typeArg);
    return found;
  }
  function nodeIntroducesTypeParams(n: ts.Node): readonly ts.TypeParameterDeclaration[] | undefined {
    if (ts.isFunctionDeclaration(n)) return n.typeParameters;
    if (ts.isFunctionExpression(n)) return n.typeParameters;
    if (ts.isArrowFunction(n)) return n.typeParameters;
    if (ts.isMethodDeclaration(n)) return n.typeParameters;
    return undefined;
  }

  // ── single walk ─────────────────────────────────────────────────────
  ts.forEachChild(sf, function visit(node) {
    const introduced = nodeIntroducesTypeParams(node);
    const pushedScope = !!(introduced && introduced.length);
    if (pushedScope) {
      enclosingTypeParamStack.push(new Set(introduced!.map(p => p.name.text)));
    }

    try {
      if (ts.isInterfaceDeclaration(node)) {
        if (node.typeParameters?.length) {
          const tpl = collectGenericInterface(node, sf, resolveImportedTypeName);
          if (tpl) templates.set(tpl.name, tpl);
        } else {
          const msg = collectInterface(node, sf, resolveImportedTypeName);
          if (msg) concrete.push(msg);
          // Queue any generic-instantiated type-args appearing as field types
          // (e.g. `wrapped: pb<5, Wrapper<uint_32>>`) for monomorphization.
          // The call-site queue only sees the outer concrete type, so without
          // this the nested instantiation would never reach the registry.
          for (const ta of collectConcreteFieldGenericTypeArgs(node, resolveImportedTypeName)) {
            deferredTypeArgs.push(ta);
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const cs = matchProtobufCallSite(node, sf, importBindings, {
          allowLegacyUnboundCanonical: true,
        });
        if (cs) {
          if (!typeArgReferencesEnclosingParam(cs.firstTypeArg)) {
            deferredTypeArgs.push(cs.firstTypeArg);
            callSites.push(cs);
          }
          // else: this call sits inside a generic wrapper definition; the
          // wrapper-binding path will materialise concrete codecs at each
          // downstream call site instead.
        } else if (
          node.typeArguments?.length &&
          getCallableName(node.expression) &&
          wrapperBindings.has(getCallableName(node.expression)!)
        ) {
          const binding = wrapperBindings.get(getCallableName(node.expression)!)!;
          const firstTypeArg = instantiateWrapperTypePattern(binding, node.typeArguments, sf);
          if (!firstTypeArg) {
            ts.forEachChild(node, visit);
            return;
          }
          const exprStart = node.expression.getStart(sf);
          const lc = sf.getLineAndCharacterOfPosition(exprStart);
          deferredTypeArgs.push(firstTypeArg);
          callSites.push({
            fnName: binding.fnName,
            exprStart,
            typeArgsEnd: node.typeArguments.end + 1,
            firstTypeArg,
            line: lc.line + 1,
            column: lc.character + 1,
          });
        }
      }

      ts.forEachChild(node, visit);
    } finally {
      if (pushedScope) enclosingTypeParamStack.pop();
    }
  });

  // ── post-walk: monomorphize deferred type args ──────────────────────
  for (const typeArg of deferredTypeArgs) {
    const typeSf = resolveSourceFileForTypeNode(typeArg, sf);
    const typeResolver = createImportedTypeNameResolver(typeSf);
    monomorphizeTypeNode(typeArg, typeSf, templates, mono, typeResolver);
  }
  for (const m of mono.values()) concrete.push(m);

  // ── resolve wire types ──────────────────────────────────────────────
  // Anything that doesn't resolve to a primitive or a registered message is
  // a type-tracking miss — historically these leaked the placeholder
  // `WireType.Varint` into codegen and corrupted the wire format silently.
  // Throw loudly instead so future analyzer gaps surface immediately.
  const names = new Set(concrete.map(m => m.name));
  for (const msg of concrete) {
    for (const f of msg.fields) {
      const prim = PRIMITIVE_TYPE_MAP[f.typeName];
      if (prim) {
        f.wireType = prim.wireType;
        f.isMessage = false;
      } else if (names.has(f.typeName)) {
        f.wireType = WireType.LengthDelim;
        f.isMessage = true;
      } else {
        throw new Error(
          `Cannot resolve protobuf field type "${f.typeName}" on message "${msg.name}" ` +
          `(field "${f.name}", field number ${f.fieldNumber}). The analyzer did not produce ` +
          `a primitive or registered message for this type. Common causes: union / intersection / ` +
          `mapped / conditional types, TypeScript utility types (Partial<T>, Pick<T>, …), ` +
          `qualified names (ns.Type), or a missing import.`,
        );
      }
    }
  }

  return { registry: topoSort(concrete), callSites, sourceFile: sf };
}

/**
 * Backward-compatible wrapper: returns only the MessageRegistry.
 * Uses the same single-walk analysis internally.
 */
export function analyzeSource(code: string, filePath: string, imported?: ImportedDefinitions): MessageRegistry {
  return analyze(code, filePath, imported).registry;
}

/**
 * Build a minimal message registry by collecting only call-site root types and
 * their transitive message dependencies.
 *
 * `extraRootNames` lets callers seed the root set with type names that
 * weren't discovered through `protobuf_encode/decode` call sites — used by
 * the subclass-wrapper pipeline to drag in codecs whose only consumer is a
 * per-subclass override generated outside this analyzer.
 */
export function selectUsedRegistry(
  registry: MessageRegistry,
  callSites: CallSiteRecord[],
  sourceFile: ts.SourceFile,
  extraRootNames?: Iterable<string>,
): UsedRegistryResult {
  const roots = new Set<string>();
  const resolved: ResolvedCallSiteRecord[] = [];
  for (const cs of callSites) {
    const typeSf = resolveSourceFileForTypeNode(cs.firstTypeArg, sourceFile);
    const typeName = typeNodeToMangledName(cs.firstTypeArg, typeSf, createImportedTypeNameResolver(typeSf));
    if (!registry.has(typeName)) continue;
    roots.add(typeName);
    resolved.push({ ...cs, typeName });
  }

  if (extraRootNames) {
    for (const name of extraRootNames) {
      if (registry.has(name)) roots.add(name);
    }
  }

  if (roots.size === 0) {
    return { registry: new Map(), roots, callSites: resolved };
  }

  return {
    registry: buildDependencyRegistry(registry, roots),
    roots,
    callSites: resolved,
  };
}

// ── topological sort ──────────────────────────────────────────────────

function topoSort(messages: ProtobufMessage[]): MessageRegistry {
  const map = new Map(messages.map(m => [m.name, m]));
  const deps = new Map(messages.map(m => [
    m.name,
    new Set(m.fields.filter(f => map.has(f.typeName)).map(f => f.typeName)),
  ]));

  const sorted: ProtobufMessage[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function dfs(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular dependency: ${name}`);
    visiting.add(name);
    for (const d of deps.get(name) || []) dfs(d);
    visiting.delete(name);
    visited.add(name);
    sorted.push(map.get(name)!);
  }

  for (const m of messages) dfs(m.name);
  return new Map(sorted.map(m => [m.name, m]));
}
