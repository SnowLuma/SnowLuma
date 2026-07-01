import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { typesForDirection } from '../src/element-manifest';

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
    // poke 按设计不支持发送（QQ 限制），element-builder 必须没有 poke 分支。
    expect(handled).not.toContain('poke');
    expect(handled).toEqual(sorted(typesForDirection('W')));
  });
});
