import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  typesForDirection,
  INPUT_SUGAR_SEGMENTS,
} from '@snowluma/protocol/element-manifest';
import { ELEMENT_CODECS } from '../src/event-converter/element-codecs';

// 对账测试（onebot 侧）—— 拿 element-manifest 核对「按 element.type 收敛」的两个
// onebot 方向。阶段 2 起这两向已合入 ELEMENT_CODECS 表，故直接用**表的键**核对，
// 比扫源码正则更硬：
//   S 收·转  codec.toSegment    MessageElement → OneBot 段
//   P 发·解  codec.fromSegment  OneBot 段 → MessageElement
// protocol 侧的 D/W 由 protocol/tests/element-manifest.test.ts 核对（包边界所限）。
//
// 架构护栏：谁在表里增删一个方向却没同步 element-manifest，测试当场报红。

function codecTypesWith(dir: 'toSegment' | 'fromSegment'): string[] {
  return Object.entries(ELEMENT_CODECS)
    .filter(([, codec]) => typeof codec[dir] === 'function')
    .map(([type]) => type)
    .sort();
}

const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe('element-manifest 对账（onebot 侧：S 收·转 / P 发·解）', () => {
  it('S：ELEMENT_CODECS 里有 toSegment 的类型 == 清单声明的 S=yes', () => {
    expect(codecTypesWith('toSegment')).toEqual(sorted(typesForDirection('S')));
  });

  it('P：ELEMENT_CODECS 里有 fromSegment 的类型 == 清单声明的 P=yes', () => {
    expect(codecTypesWith('fromSegment')).toEqual(sorted(typesForDirection('P')));
  });

  it('OneBot 输入词仍由 message-parser 前置处理或明确拒绝，未被静默丢弃', () => {
    // 输入词（骰子/分享/node/anonymous/…）不进 codec 表，留在 parser 前置处理。
    // 用源码扫描锁住它们确实存在，防止将来重构时被悄悄删掉。
    const abs = fileURLToPath(new URL('../src/message-parser.ts', import.meta.url));
    const src = readFileSync(abs, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const cases = new Set<string>();
    for (const m of src.matchAll(/case\s*'([A-Za-z0-9_]+)'\s*:/g)) cases.add(m[1]!);

    const sugarPresent = [...cases].filter((t) => INPUT_SUGAR_SEGMENTS.has(t)).sort();
    expect(sugarPresent).toEqual(sorted(INPUT_SUGAR_SEGMENTS));

    // 且 message-parser 不再手写任何真实元素类型的 case（已全部下沉到 codec 表）。
    const realLeftInParser = [...cases].filter((t) => !INPUT_SUGAR_SEGMENTS.has(t));
    expect(realLeftInParser).toEqual([]);
  });

  it('poke 的 P/S 字段都使用 subType，不再漂移到 faceId', async () => {
    const parsed = await ELEMENT_CODECS.poke!.fromSegment!({ type: 7 });
    expect(parsed).toEqual({ type: 'poke', subType: 7 });
    expect(parsed).not.toHaveProperty('faceId');

    const segment = await ELEMENT_CODECS.poke!.toSegment!(parsed!, {} as never);
    expect(segment).toEqual({ type: 'poke', data: { type: 7 } });
  });
});
