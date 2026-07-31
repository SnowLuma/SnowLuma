import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IconMorph, iconMorphPresets } from '../src/components/interior/icon-morph';

describe('mobile menu icon morph', () => {
  it('keeps the Interior menu and close geometry unchanged', () => {
    expect(iconMorphPresets['menu-close'].shapes).toEqual([
      {
        rotate: 0,
        d: ['M 4 7 L 20 7', 'M 4 12 L 20 12', 'M 4 17 L 20 17'],
      },
      {
        rotate: 90,
        d: ['M 6.5 6.5 L 17.5 17.5', 'M 12 12 L 12 12', 'M 6.5 17.5 L 17.5 6.5'],
      },
    ]);
  });

  it('reflects the controlled sheet state in its accessible semantics', () => {
    const menu = renderToStaticMarkup(
      <IconMorph
        preset="menu-close"
        labels={['打开菜单', '关闭菜单']}
        semantics="expanded"
        active={false}
      />,
    );
    const close = renderToStaticMarkup(
      <IconMorph
        preset="menu-close"
        labels={['打开菜单', '关闭菜单']}
        semantics="expanded"
        active
      />,
    );

    expect(menu).toContain('aria-label="打开菜单"');
    expect(menu).toContain('aria-expanded="false"');
    expect(close).toContain('aria-label="关闭菜单"');
    expect(close).toContain('aria-expanded="true"');
  });
});
