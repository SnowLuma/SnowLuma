import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EMAIL_BODY,
  DEFAULT_WEBHOOK_BODY,
  NotificationChannelDialog,
} from '../src/components/settings/notification-channel-dialog';

vi.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ appearance: { disableMotion: true, reduceMotion: true } }),
}));

vi.mock('@/components/interior/modal', () => ({
  Modal: ({
    title,
    description,
    children,
    footer,
  }: {
    title: string;
    description?: string;
    children?: unknown;
    footer?: unknown;
  }) => (
    <div>
      <h1>{title}</h1>
      {description ? <p>{description}</p> : null}
      {children}
      <div>{footer}</div>
    </div>
  ),
}));

describe('NotificationChannelDialog', () => {
  it('shows webhook fields for a new webhook channel', () => {
    const markup = renderToStaticMarkup(
      <NotificationChannelDialog
        open
        onOpenChange={() => undefined}
        isEdit={false}
        initial={{
          id: 'channel-1',
          name: '',
          type: 'webhook',
          url: '',
          bodyTemplate: DEFAULT_WEBHOOK_BODY,
          enabled: true,
        }}
        otherIds={[]}
        onSubmit={() => undefined}
      />,
    );
    expect(markup).toContain('Webhook URL');
    expect(markup).toContain('请求头');
    expect(markup).not.toContain('SMTP 主机');
    expect(markup).toContain('向该 Webhook POST');
  });

  it('shows SMTP fields for an email channel', () => {
    const markup = renderToStaticMarkup(
      <NotificationChannelDialog
        open
        onOpenChange={() => undefined}
        isEdit
        initial={{
          id: 'ops-mail',
          name: '运维邮箱',
          type: 'email',
          url: '',
          bodyTemplate: DEFAULT_EMAIL_BODY,
          enabled: true,
          smtpHost: 'smtp.qq.com',
          smtpPort: 465,
          smtpSecure: true,
          from: 'bot@qq.com',
          to: 'ops@example.com',
        }}
        otherIds={[]}
        onSubmit={() => undefined}
      />,
    );
    expect(markup).toContain('SMTP 主机');
    expect(markup).toContain('smtp.qq.com');
    expect(markup).toContain('发件人');
    expect(markup).toContain('收件人');
    expect(markup).toContain('主题模板');
    expect(markup).toContain('隐式 TLS');
    expect(markup).not.toContain('Webhook URL');
    expect(markup).toContain('向该邮箱发送');
  });
});
