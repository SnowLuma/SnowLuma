import { readFileSync } from 'node:fs';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { SendMessageResponse } from '@snowluma/proto-defs/action';
import type { Elem } from '@snowluma/proto-defs/element';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import { IdentityService } from '@snowluma/protocol/identity-service';
import {
    type bytes,
    type pb,
    type pb_repeated,
    protobuf_decode,
    protobuf_encode,
} from '@snowluma/proton';
import { expect, it } from 'vitest';
import { Bridge } from '../src/bridge/bridge';

interface VoiceParts {
    elems?: pb_repeated<2, bytes>;
    ptt?: pb<4, bytes>;
}

interface UploadReply {
    upload?: pb<2, { compat?: pb<8, bytes> }>;
}

interface OutgoingMessage {
    body?: pb<3, { richText?: pb<1, VoiceParts> }>;
}

it('preserves the private voice returned for older clients alongside the modern voice', async () => {
    // The upload reply from #614, with identifiers redacted and transport credentials removed.
    const upload = Buffer.from(
        readFileSync(
            new URL('./fixtures/issue-614-private-voice-upload.hex', import.meta.url),
            'utf8',
        ).replace(/\s/g, ''),
        'hex',
    );
    const captured = protobuf_decode<OidbBase<UploadReply>>(Uint8Array.from(upload)).body!.upload!
        .compat!;
    const expected = protobuf_decode<VoiceParts>(captured);
    expect(captured).toHaveLength(301);
    expect(expected.ptt).toHaveLength(253);
    let sent: VoiceParts | undefined;

    class VoiceBridge extends Bridge {
        override async resolveUserUid(): Promise<string> {
            return 'u_peer';
        }

        override async sendRawPacket(cmd: string, body: Uint8Array): Promise<SendPacketResult> {
            let response: Uint8Array;

            if (cmd === 'OidbSvcTrpcTcp.0x126d_100') {
                response = upload;
            } else if (cmd === 'MessageSvc.PbSendMsg') {
                sent = protobuf_decode<OutgoingMessage>(body).body!.richText!;
                response = protobuf_encode<SendMessageResponse>({ privateSequence: 88 });
            } else {
                throw new Error(`Unexpected packet ${cmd}`);
            }

            return {
                success: true,
                gotResponse: true,
                errorCode: 0,
                errorMessage: '',
                responseData: Buffer.from(response),
            };
        }
    }

    const bridge = new VoiceBridge(IdentityService.memory('10000'));
    await bridge.apis.message.sendPrivate(10001, [
        {
            type: 'record',
            noByteFallback: true,
            fileSize: 7931,
            duration: 3,
            md5Hex: '0'.repeat(32),
            sha1Hex: '0'.repeat(40),
            fileName: 'voice.amr',
        },
    ]);
    expect(protobuf_decode<Elem>(sent!.elems![0]!).commonElem).toMatchObject({
        serviceType: 48,
        businessType: 12,
    });
    expect(sent!.ptt).toEqual(expected.ptt);
    expect(sent!.elems!.slice(1)).toEqual(expected.elems);
});
