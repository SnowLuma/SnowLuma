import { describe, expect, it } from 'vitest';
import {
  applyType,
  DEFAULT_EMAIL_BODY,
  DEFAULT_EMAIL_SUBJECT,
  DEFAULT_WEBHOOK_BODY,
  toChannel,
} from '../src/components/settings/notification-channel-dialog';
import { notificationChannelType, type NotificationChannel } from '../src/types';

function webhook(over: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'hook',
    name: 'Hook',
    type: 'webhook',
    url: 'https://example.com/hook',
    bodyTemplate: DEFAULT_WEBHOOK_BODY,
    enabled: true,
    ...over,
  };
}

describe('notificationChannelType', () => {
  it('treats a missing type as webhook', () => {
    expect(notificationChannelType({ type: undefined })).toBe('webhook');
    expect(notificationChannelType({ type: 'email' })).toBe('email');
  });
});

describe('applyType', () => {
  it('swaps the default webhook body for the email body when switching', () => {
    const next = applyType(webhook(), 'email');
    expect(next.type).toBe('email');
    expect(next.url).toBe('');
    expect(next.bodyTemplate).toBe(DEFAULT_EMAIL_BODY);
    expect(next.subjectTemplate).toBe(DEFAULT_EMAIL_SUBJECT);
    expect(next.smtpPort).toBe(465);
    expect(next.smtpSecure).toBe(true);
  });

  it('keeps a custom body when switching to email', () => {
    const next = applyType(webhook({ bodyTemplate: 'custom {event}' }), 'email');
    expect(next.bodyTemplate).toBe('custom {event}');
  });

  it('drops SMTP fields when switching back to webhook', () => {
    const email = applyType(webhook(), 'email');
    const back = applyType({ ...email, smtpPass: 'secret' }, 'webhook');
    expect(back.type).toBe('webhook');
    expect(back).not.toHaveProperty('smtpPass');
    expect(back).not.toHaveProperty('smtpHost');
    expect(back.bodyTemplate).toBe(DEFAULT_WEBHOOK_BODY);
  });
});

describe('toChannel', () => {
  it('emits a webhook without email fields and with trimmed headers', () => {
    const ch = toChannel(webhook({ headers: { leftover: 'x' } }), [
      { name: ' Authorization ', value: ' Bearer a ' },
      { name: '', value: 'skip' },
    ]);
    expect(ch).toEqual({
      id: 'hook',
      name: 'Hook',
      type: 'webhook',
      url: 'https://example.com/hook',
      bodyTemplate: DEFAULT_WEBHOOK_BODY,
      enabled: true,
      headers: { Authorization: 'Bearer a' },
    });
  });

  it('emits email fields and an empty url', () => {
    const ch = toChannel({
      id: ' mail ',
      name: ' Ops ',
      type: 'email',
      url: 'https://ignored',
      bodyTemplate: DEFAULT_EMAIL_BODY,
      enabled: true,
      smtpHost: ' smtp.qq.com ',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: ' bot@qq.com ',
      smtpPass: 'secret',
      from: ' SnowLuma <bot@qq.com> ',
      to: ' ops@example.com ',
      subjectTemplate: ' {event} ',
    }, []);
    expect(ch).toEqual({
      id: 'mail',
      name: 'Ops',
      type: 'email',
      url: '',
      bodyTemplate: DEFAULT_EMAIL_BODY,
      enabled: true,
      smtpHost: 'smtp.qq.com',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: 'bot@qq.com',
      smtpPass: 'secret',
      from: 'SnowLuma <bot@qq.com>',
      to: 'ops@example.com',
      subjectTemplate: '{event}',
    });
  });
});
