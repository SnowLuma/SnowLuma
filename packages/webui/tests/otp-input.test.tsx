import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OtpInput } from '../src/components/interior/otp-input';

describe('OtpInput official error/hint contract', () => {
  it('shows the hint while error is false', () => {
    const markup = renderToStaticMarkup(
      <OtpInput
        label="验证码"
        hint="可以把完整验证码粘贴到任意一格。"
        error={false}
        errorMessage="验证码不正确，改错的那一位即可。"
      />,
    );
    expect(markup).toContain('可以把完整验证码粘贴到任意一格。');
    expect(markup).not.toContain('验证码不正确，改错的那一位即可。');
  });

  it('swaps to the error message when error is true', () => {
    const markup = renderToStaticMarkup(
      <OtpInput
        label="验证码"
        hint="可以把完整验证码粘贴到任意一格。"
        error
        errorMessage="验证码不正确，改错的那一位即可。"
      />,
    );
    expect(markup).toContain('验证码不正确，改错的那一位即可。');
    expect(markup).toContain('aria-invalid="true"');
  });
});
