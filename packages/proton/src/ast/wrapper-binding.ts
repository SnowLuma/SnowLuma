import ts from 'typescript';
import { registerSyntheticTypeSourceFile } from './utils.js';
import type { CanonicalProtobufFn } from './callsite.js';

export interface WrapperBinding {
  fnName: CanonicalProtobufFn;
  typeArgIndex: number;
  typePattern?: string;
  typeParamNames?: string[];
  sourceFilePath?: string;
}

/** Instantiate the concrete encoded/decoded type behind a wrapper binding.
 *
 * Wrapper binding discovery records either:
 * - a direct forwarded type-argument index (`protobuf_encode<T>`), or
 * - a structural type pattern that must be substituted at the call site
 *   (`encode<T>(x: Wrapper<T>)` → `Wrapper<Concrete>`).
 *
 * The parsed synthetic type is registered with its synthetic SourceFile so
 * downstream `typeNodeToMangledName()` / import resolution can read the
 * substituted text from the correct backing file instead of from the caller's
 * original source text.
 */
export function instantiateWrapperTypePattern(
  binding: WrapperBinding,
  callerTypeArgs: ts.NodeArray<ts.TypeNode>,
  sf: ts.SourceFile,
): ts.TypeNode | null {
  if (!binding.typePattern || !binding.typeParamNames?.length) {
    return callerTypeArgs[binding.typeArgIndex] ?? null;
  }

  let text = binding.typePattern;
  for (let i = 0; i < binding.typeParamNames.length; i++) {
    const arg = callerTypeArgs[i];
    if (!arg) return null;
    text = text.replace(new RegExp(`\\b${binding.typeParamNames[i]}\\b`, 'g'), arg.getText(sf));
  }

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
