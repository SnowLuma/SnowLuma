import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  typesForDirection,
  INPUT_SUGAR_SEGMENTS,
} from '@snowluma/protocol/element-manifest';

// 对账测试（onebot 侧）—— 拿 element-manifest 核对「按 element.type 收敛」的两个
// onebot 方向：
//   S 收·转  to-segment.ts 的 `element.type === 'X'` 分支集合
//   P 发·解  message-parser.ts 的 `case 'X'` 分支集合（剔除纯输入糖）
// protocol 侧的 D/W 由 protocol/tests/element-manifest.test.ts 核对（包边界所限）。
//
// 架构护栏：谁在这两处增删一种元素方向却没同步 element-manifest，测试当场报红。
// 纯读源码、零运行时行为改动。

function readSrc(relFromTestDir: string): string {
  const abs = fileURLToPath(new URL(relFromTestDir, import.meta.url));
  const raw = readFileSync(abs, 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function extractTypes(src: string, pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(pattern)) found.add(m[1]!);
  return [...found].sort();
}

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe('element-manifest 对账（onebot 侧：S 收·转 / P 发·解）', () => {
  it('S：to-segment 的 element.type 分支 == 清单声明的 S=yes', () => {
    const src = readSrc('../src/event-converter/to-segment.ts');
    const handled = extractTypes(src, /element\.type\s*===\s*'([A-Za-z0-9_]+)'/g);
    expect(handled).toEqual(sorted(typesForDirection('S')));
  });

  it('P：message-parser 的 case 分支（剔除输入糖）== 清单声明的 P=yes', () => {
    const src = readSrc('../src/message-parser.ts');
    // 值域放宽到 `[A-Za-z0-9_]+`：见 protocol/tests/element-manifest.test.ts 同处说明。
    const allCases = extractTypes(src, /case\s*'([A-Za-z0-9_]+)'\s*:/g);
    const realElementCases = allCases.filter((t) => !INPUT_SUGAR_SEGMENTS.has(t));
    expect(realElementCases).toEqual(sorted(typesForDirection('P')));

    // 输入糖必须确实出现在 message-parser 里（否则白名单与代码脱节）。
    const sugarPresent = allCases.filter((t) => INPUT_SUGAR_SEGMENTS.has(t)).sort();
    expect(sugarPresent).toEqual(sorted(INPUT_SUGAR_SEGMENTS));
  });
});
