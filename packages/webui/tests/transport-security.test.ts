import { describe, expect, it } from 'vitest';
import {
  isLoopbackHostname,
  shouldWarnAboutInsecureRemoteAccess,
} from '../src/lib/transport-security';

describe('WebUI transport security notice', () => {
  it.each([
    'localhost',
    'dashboard.localhost',
    '127.0.0.1',
    '127.42.1.9',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
  ])('recognizes %s as a loopback browser hostname', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '192.168.1.20',
    '10.0.0.8',
    'snowluma.example.com',
    '::ffff:192.168.1.20',
  ])('does not treat %s as loopback', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });

  it('warns only when a non-loopback page is accessed without HTTPS', () => {
    expect(shouldWarnAboutInsecureRemoteAccess({ protocol: 'http:', hostname: '192.168.1.20' }))
      .toBe(true);
    expect(shouldWarnAboutInsecureRemoteAccess({ protocol: 'https:', hostname: '192.168.1.20' }))
      .toBe(false);
    expect(shouldWarnAboutInsecureRemoteAccess({ protocol: 'http:', hostname: '127.0.0.1' }))
      .toBe(false);
  });
});
