import { describe, expect, it, vi } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { GetGroupShareLink } from '../../../src/oidb-services/contacts/get-group-share-link';
import type { OidbSender } from '../../../src/oidb-service';
import { env, m, s, v } from '../_pb-oracle';

const shortUrl = 'https://qm.qq.com/q/example';
const params: GetGroupShareLink.Params = {
    groupId: 12345,
    needShortUrl: true,
    srcId: 73,
    additionalParam: '',
};

function sender(body: number[] = m(12, s(1, shortUrl))) {
    const packet: SendPacketResult = {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(env(0x9060, 3, body, true), 'hex'),
    };
    return {
        packet,
        sendRawPacket: vi.fn<OidbSender['sendRawPacket']>().mockResolvedValue(packet),
    };
}

describe('GetGroupShareLink', () => {
    it('requests a short group link using the verified packet layout', async () => {
        const deps = sender();

        await expect(GetGroupShareLink.invoke(deps, params)).resolves.toBe(shortUrl);

        const body = [...v(1, 2), ...m(12, [...v(1, 12345), ...s(3, ''), ...v(4, 1)])];
        expect(deps.sendRawPacket).toHaveBeenCalledExactlyOnceWith(
            'OidbSvcTrpcTcp.0x9060_3',
            new Uint8Array(Buffer.from(env(0x9060, 3, body, true), 'hex')),
        );
    });

    it('preserves a false short-link flag, additional parameters, and the returned long URL', async () => {
        const url = 'https://qm.qq.com/cgi-bin/qm/qr?k=example&jump_from=webapi';
        const additionalParam = 'source=群二维码&test=1';
        const deps = sender(m(12, s(1, url)));

        await expect(
            GetGroupShareLink.invoke(deps, { ...params, needShortUrl: false, additionalParam }),
        ).resolves.toBe(url);

        const body = [...v(1, 2), ...m(12, [...v(1, 12345), ...s(3, additionalParam), ...v(4, 0)])];
        expect(Buffer.from(deps.sendRawPacket.mock.calls[0]![1]).toString('hex')).toBe(
            env(0x9060, 3, body, true),
        );
    });

    it.each([0, 73, 0xffffffff])(
        'retains client-compatible behavior for source %s',
        async (srcId) => {
            const deps = sender();
            await GetGroupShareLink.invoke(deps, { ...params, srcId });

            const body = [...v(1, 2), ...m(12, [...v(1, 12345), ...s(3, ''), ...v(4, 1)])];
            expect(Buffer.from(deps.sendRawPacket.mock.calls[0]![1]).toString('hex')).toBe(
                env(0x9060, 3, body, true),
            );
        },
    );

    it.each([
        ['missing result', []],
        ['missing URL', m(12, [])],
        ['empty URL', m(12, s(1, ''))],
        ['blank URL', m(12, s(1, '   '))],
    ] as const)('rejects a successful response with %s', async (_name, body) => {
        await expect(GetGroupShareLink.invoke(sender([...body]), params)).rejects.toThrow(
            'group share link response did not include a URL',
        );
    });

    it('preserves server errors even if the response includes a URL', async () => {
        const deps = sender();
        deps.packet.responseData = Buffer.from([
            ...v(1, 0x9060),
            ...v(2, 3),
            ...v(3, 403),
            ...m(4, m(12, s(1, shortUrl))),
            ...s(5, 'permission denied'),
        ]);

        await expect(GetGroupShareLink.invoke(deps, params)).rejects.toMatchObject({
            name: 'OidbError',
            code: 403,
            serverMsg: 'permission denied',
        });
    });

    it('reports a transport timeout instead of inventing a URL', async () => {
        const deps = sender();
        deps.packet.success = false;
        deps.packet.gotResponse = false;
        deps.packet.errorMessage = 'request timed out';

        await expect(GetGroupShareLink.invoke(deps, params)).rejects.toThrow('request timed out');
    });

    it('rejects a truncated response', async () => {
        const deps = sender();
        deps.packet.responseData = Buffer.from([0x22, 0x03, 0x62, 0xff]);

        await expect(GetGroupShareLink.invoke(deps, params)).rejects.toThrow();
    });
});
