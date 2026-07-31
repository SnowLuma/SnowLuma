import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FloatingLabelInput } from '../src/components/interior/floating-label';
import { InlineValidation } from '../src/components/interior/inline-validation';
import {
  PasswordStrength,
  type PasswordRule,
} from '../src/components/interior/password-strength';

const RULES: readonly PasswordRule[] = [
  { id: 'length', label: '长度不少于 10 位', test: (value) => value.length >= 10 },
  { id: 'upper', label: '包含大写字母', test: (value) => /[A-Z]/.test(value) },
];

describe('password input guidance', () => {
  it('renders an accessible floating password label', () => {
    const markup = renderToStaticMarkup(
      <FloatingLabelInput
        id="password"
        label="新密码"
        type="password"
        value=""
        required
        onChange={() => {}}
      />,
    );

    expect(markup).toContain('id="password"');
    expect(markup).toContain('for="password"');
    expect(markup).toContain('新密码');
    expect(markup).toContain('aria-required="true"');
  });

  it('keeps the strength details out of the tree while hidden', () => {
    const markup = renderToStaticMarkup(
      <PasswordStrength value="SnowLuma-Test" rules={RULES} visible={false} />,
    );

    expect(markup).not.toContain('role="meter"');
    expect(markup).not.toContain('长度不少于 10 位');
  });

  it('shows the evaluated strength details while visible', () => {
    const markup = renderToStaticMarkup(
      <PasswordStrength value="SnowLuma-Test" rules={RULES} visible />,
    );

    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('长度不少于 10 位');
    expect(markup).toContain('包含大写字母');
  });

  it('renders inline validation with its hint and status channel', () => {
    const markup = renderToStaticMarkup(
      <InlineValidation
        id="confirm-password"
        label="确认新密码"
        value=""
        onChange={() => {}}
        validate={(value) => value ? null : '请再次输入新密码'}
        hint="需要与新密码完全一致"
      />,
    );

    expect(markup).toContain('确认新密码');
    expect(markup).toContain('需要与新密码完全一致');
    expect(markup).toContain('role="status"');
  });
});
