import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SkeletonSwap } from '../src/components/interior/skeleton-swap';

describe('SkeletonSwap', () => {
  it('reserves the requested space without painting a skeleton immediately', () => {
    const html = renderToStaticMarkup(
      <SkeletonSwap ready={false} reserve={84} lines={4} label="测试内容">
        <div>尚未就绪</div>
      </SkeletonSwap>,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('height:84px');
    expect(html).toContain('尚未就绪');
    expect(html).not.toContain('aria-hidden="true"');
  });

  it('exposes ready content without a loading announcement', () => {
    const html = renderToStaticMarkup(
      <SkeletonSwap ready label="测试内容">
        <div>内容已加载</div>
      </SkeletonSwap>,
    );

    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('内容已加载');
    expect(html).toContain('测试内容 loaded');
  });
});
