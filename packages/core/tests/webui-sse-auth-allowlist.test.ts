import { describe, expect, it } from 'vitest';
import { extractWebuiSessionToken } from '../src/webui/request-security';

describe('WebUI stream authentication', () => {
    it('accepts a dedicated session header alongside proxy credentials for every stream', () => {
        for (const path of [
            '/api/logs/stream',
            '/api/debug/stream',
            '/api/state/stream',
            '/api/debug/invoke-stream',
        ]) {
            const request = new Request(`http://localhost${path}`, {
                headers: {
                    authorization: 'Basic cHJveHk6cGFzc3dvcmQ=',
                    'X-SnowLuma-Token': 'stream-token',
                },
            });
            expect(extractWebuiSessionToken(request)).toBe('stream-token');
        }
    });

    it('accepts bearer credentials for every live stream', () => {
        for (const path of ['/api/logs/stream', '/api/debug/stream', '/api/state/stream']) {
            const request = new Request(`http://localhost${path}`, {
                headers: { authorization: 'Bearer stream-token' },
            });
            expect(extractWebuiSessionToken(request)).toBe('stream-token');
        }
    });

    it('does not accept tokens from stream query parameters', () => {
        for (const path of ['/api/logs/stream', '/api/debug/stream', '/api/state/stream']) {
            expect(
                extractWebuiSessionToken(new Request(`http://localhost${path}?token=leaked`)),
            ).toBe('');
        }
    });
});
