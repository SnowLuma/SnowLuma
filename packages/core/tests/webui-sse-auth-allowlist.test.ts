import { describe, expect, it } from 'vitest';
import { extractBearerToken } from '../src/webui/request-security';

describe('WebUI stream authentication', () => {
  it('accepts bearer credentials for every live stream', () => {
    for (const path of ['/api/logs/stream', '/api/debug/stream', '/api/state/stream']) {
      const request = new Request(`http://localhost${path}`, {
        headers: { authorization: 'Bearer stream-token' },
      });
      expect(extractBearerToken(request)).toBe('stream-token');
    }
  });

  it('does not accept tokens from stream query parameters', () => {
    for (const path of ['/api/logs/stream', '/api/debug/stream', '/api/state/stream']) {
      expect(extractBearerToken(new Request(`http://localhost${path}?token=leaked`))).toBe('');
    }
  });
});
