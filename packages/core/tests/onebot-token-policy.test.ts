import { describe, expect, it } from 'vitest';
import { makeDefaultOneBotConfig } from '@snowluma/onebot/config';
import {
  OneBotAccessTokenPolicyError,
  validateOneBotAccessTokenChanges,
} from '../src/webui/onebot-token-policy';

function validate(
  previous: ReturnType<typeof makeDefaultOneBotConfig> | null,
  next: ReturnType<typeof makeDefaultOneBotConfig>,
  clientIp: string,
): void {
  validateOneBotAccessTokenChanges(previous, next, { clientIp, uin: '10001' });
}

describe('OneBot access token save policy', () => {
  it('rejects clearing an inbound token from a non-loopback client when the bind host is public', () => {
    const previous = makeDefaultOneBotConfig();
    const next = structuredClone(previous);
    next.networks.httpServers[0].host = '0.0.0.0';
    next.networks.httpServers[0].accessToken = undefined;

    expect(() => validate(previous, next, '192.0.2.10')).toThrow(OneBotAccessTokenPolicyError);
    expect(() => validate(previous, next, '192.0.2.10')).toThrow(/令牌/);
  });

  it('allows a remote client to clear a token when the inbound host is loopback', () => {
    const previous = makeDefaultOneBotConfig();
    const next = structuredClone(previous);
    next.networks.httpServers[0].host = '127.0.0.1';
    next.networks.httpServers[0].accessToken = undefined;

    expect(() => validate(previous, next, '192.0.2.10')).not.toThrow();
  });

  it('treats localhost as a loopback bind host for empty inbound tokens', () => {
    const previous = makeDefaultOneBotConfig();
    const next = structuredClone(previous);
    next.networks.wsServers[0].host = 'localhost';
    next.networks.wsServers[0].accessToken = undefined;

    expect(() => validate(previous, next, '192.0.2.10')).not.toThrow();
  });

  it('does not treat a missing bind host as loopback', () => {
    const previous = makeDefaultOneBotConfig();
    const next = structuredClone(previous);
    next.networks.httpServers[0].host = undefined;
    next.networks.httpServers[0].accessToken = undefined;

    expect(() => validate(previous, next, '192.0.2.10')).toThrow(OneBotAccessTokenPolicyError);
  });

  it('treats every inbound token as new when no readable prior config exists', () => {
    const next = makeDefaultOneBotConfig();
    next.networks.httpServers[0].host = '0.0.0.0';
    next.networks.httpServers[0].accessToken = undefined;

    expect(() => validate(null, next, '192.0.2.10')).toThrow(OneBotAccessTokenPolicyError);
  });

  it('allows a loopback client to deliberately clear an inbound token', () => {
    const previous = makeDefaultOneBotConfig();
    const next = structuredClone(previous);
    next.networks.wsServers[0].accessToken = undefined;

    expect(() => validate(previous, next, '127.0.0.2')).not.toThrow();
  });

  it('rejects a newly changed weak inbound token', () => {
    const previous = makeDefaultOneBotConfig();
    const next = structuredClone(previous);
    next.networks.httpServers[0].accessToken = 'SnowLumaSnowLuma';

    expect(() => validate(previous, next, '127.0.0.1')).toThrow(/容易被猜中/);
  });

  it('does not strand installations whose legacy token is unchanged', () => {
    const previous = makeDefaultOneBotConfig();
    previous.networks.httpServers[0].accessToken = 'legacy';
    const next = structuredClone(previous);
    next.networks.httpServers[0].name = 'renamed-http';
    next.networks.httpServers[0].port = 3100;

    expect(() => validate(previous, next, '192.0.2.10')).not.toThrow();
  });

  it('allows remote edits that leave an existing empty inbound token unchanged', () => {
    const previous = makeDefaultOneBotConfig();
    previous.networks.httpServers[0].accessToken = undefined;
    const next = structuredClone(previous);
    next.networks.httpServers[0].port = 3100;

    expect(() => validate(previous, next, '192.0.2.10')).not.toThrow();
  });

  it('preserves legacy tokens when existing endpoints are reordered by name', () => {
    const previous = makeDefaultOneBotConfig();
    previous.networks.httpServers[0].accessToken = 'legacy';
    previous.networks.httpServers.push({
      ...previous.networks.httpServers[0],
      name: 'second-http',
      port: 3100,
    });
    const next = structuredClone(previous);
    next.networks.httpServers.reverse();

    expect(() => validate(previous, next, '192.0.2.10')).not.toThrow();
  });

  it('does not mistake an inserted endpoint for a renamed legacy endpoint', () => {
    const previous = makeDefaultOneBotConfig();
    previous.networks.httpServers[0].accessToken = 'legacy';
    const next = structuredClone(previous);
    next.networks.httpServers.unshift({
      ...next.networks.httpServers[0],
      name: 'new-http',
      port: 3100,
    });

    expect(() => validate(previous, next, '192.0.2.10')).toThrow(OneBotAccessTokenPolicyError);
  });

  it('does not impose local inbound-token policy on outbound adapters', () => {
    const previous = makeDefaultOneBotConfig();
    const next = structuredClone(previous);
    next.networks.httpClients.push({
      name: 'remote-service',
      url: 'https://example.com/events',
      accessToken: 'remote-chosen-token',
      messageFormat: 'array',
      reportSelfMessage: false,
    });

    expect(() => validate(previous, next, '192.0.2.10')).not.toThrow();
  });

  it('accepts a newly changed strong inbound token', () => {
    const previous = makeDefaultOneBotConfig();
    const next = structuredClone(previous);
    next.networks.wsServers[0].accessToken = 'E5xqVb7_9pLt2QwR4M8kZ1nY';

    expect(() => validate(previous, next, '192.0.2.10')).not.toThrow();
  });
});
