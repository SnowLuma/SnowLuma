import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ELEMENT_MANIFEST,
  MessageElementValidationError,
  assertValidMessageElement,
  typesForDirection,
} from '../src/element-manifest';

// 对账测试（protocol 侧）—— 拿 element-manifest 核对「按 element.type 收敛」的
// 两个 protocol 方向：
//   D 收·解    rich-body-decoder.ts 产出的 MessageElement 类型集合
//   W 发·打包  element-builder.ts 的 switch 分支集合
// onebot 侧的 S/P 由 onebot/tests/element-manifest.test.ts 核对（包边界所限）。
//
// 这是一道架构护栏（fitness function）：谁在这两处新增/删除一种元素方向，却没有
//同步更新 element-manifest，测试立即报红——把「漏写一个方向」从运行时兜底静默
// 变成 CI 当场可见。纯读源码、零运行时行为改动。

function readSrc(relFromTestDir: string): string {
  const abs = fileURLToPath(new URL(relFromTestDir, import.meta.url));
  const raw = readFileSync(abs, 'utf8');
  // 剥掉块注释与行注释，避免注释里出现的类型字面量污染扫描结果。
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** 抽出所有匹配 `pattern` 第 1 捕获组的去重、排序类型名。 */
function extractTypes(src: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(pattern)) found.add(m[1]!);
  return [...found].sort();
}

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe('element-manifest 对账（protocol 侧：D 收·解 / W 发·打包）', () => {
  it('D：rich-body-decoder 产出的元素类型 == 清单声明的 D=yes', () => {
    const src = readSrc('../src/msg-push/rich-body-decoder.ts');
    // 解码产出形如 `result.push({ type: 'image', ... })` / `{ type: 'reply', ... }`。
    // 值域放宽到 `[A-Za-z0-9_]+`（而非仅小写）：类型名当前虽全小写，但收紧到
    // `[a-z]+` 会让未来的驼峰/下划线类型名被静默漏抓，护栏就形同虚设——正是本
    // 重构要消灭的"漏一个方向、走 default 静默"失效模式，不能在护栏自身重演。
    const handled = extractTypes(src, /(?<![A-Za-z])type:\s*'([A-Za-z0-9_]+)'/g);
    expect(handled).toEqual(sorted(typesForDirection('D')));
  });

  it('W：element-builder 的 switch 分支 == 清单声明的 W=yes', () => {
    const src = readSrc('../src/element-builder.ts');
    const handled = extractTypes(src, /case\s*'([A-Za-z0-9_]+)'\s*:/g);
    expect(handled).toEqual(sorted(typesForDirection('W')));
  });

  it('fields 是可执行封闭契约：每个声明字段都有 validator，越界字段会拒绝', () => {
    const sampleValue = (field: string): unknown => {
      if (field === 'replyElements') return [];
      if (field === 'forwardNews') return [{ text: 'preview' }];
      if (field === 'mediaNode') return {};
      if (field === 'emojiId' || field === 'md5Hex') return 'ab'.repeat(16);
      if (field === 'sha1Hex') return 'cd'.repeat(20);
      if (field === 'flash' || field === 'noByteFallback') return true;
      if (field === 'targetUin' || field === 'faceId' || field === 'fileSize'
        || field.startsWith('reply') || field === 'subType' || field === 'duration'
        || field === 'width' || field === 'height' || field === 'emojiPackageId'
        || field === 'sceneType' || field === 'forwardTSum' || field.endsWith('Format')) return 1;
      return 'value';
    };

    for (const [type, spec] of Object.entries(ELEMENT_MANIFEST)) {
      expect(new Set(spec.fields).size, `${type} has duplicate fields`).toBe(spec.fields.length);
      for (const required of spec.requiredFields) expect(spec.fields).toContain(required);
      const element: Record<string, unknown> = { type };
      for (const field of spec.fields) element[field] = sampleValue(field);
      expect(() => assertValidMessageElement(element), type).not.toThrow();
    }

    expect(() => assertValidMessageElement({ type: 'poke', subType: 1, faceId: 1 }))
      .toThrowError(expect.objectContaining({
        name: 'MessageElementValidationError',
        code: 'UNEXPECTED_FIELD',
        elementType: 'poke',
        field: 'faceId',
      }));
    expect(() => assertValidMessageElement({ type: 'reply' }))
      .toThrowError(expect.objectContaining({ code: 'MISSING_FIELD', field: 'replySeq' }));
    expect(() => assertValidMessageElement({ type: 'toString' }))
      .toThrowError(expect.objectContaining({ code: 'UNKNOWN_TYPE', elementType: 'toString' }));
    expect(() => assertValidMessageElement({ type: 'mface', emojiId: 'zz' }, 'W'))
      .toThrowError(expect.objectContaining({ code: 'INVALID_FIELD', field: 'emojiId' }));
    expect(() => assertValidMessageElement({
      type: 'image',
      url: 'https://example.com/a.png',
      md5Hex: 'not-md5',
    }, 'W')).toThrowError(expect.objectContaining({ code: 'INVALID_FIELD', field: 'md5Hex' }));
  });

  it('returns a stable typed validation error for BAD_REQUEST mapping', () => {
    try {
      assertValidMessageElement({ type: 'unknown-segment' }, 'W');
      expect.unreachable('validation should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MessageElementValidationError);
      expect(error).toMatchObject({ code: 'UNKNOWN_TYPE', elementType: 'unknown-segment' });
    }
  });

  it('rejects invalid wire ranges and incomplete fast-upload fingerprints', () => {
    expect(() => assertValidMessageElement({
      type: 'file',
      fileId: 'fid',
      fileSize: -1,
    }, 'P')).toThrowError(expect.objectContaining({
      code: 'INVALID_FIELD',
      field: 'fileSize',
    }));
    expect(() => assertValidMessageElement({
      type: 'image',
      url: 'https://example.com/fallback-must-not-be-used.png',
      noByteFallback: true,
    }, 'W')).toThrowError(expect.objectContaining({
      code: 'MISSING_FIELD',
      field: 'md5Hex',
    }));
  });
});
