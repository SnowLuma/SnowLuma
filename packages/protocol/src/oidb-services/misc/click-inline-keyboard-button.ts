// 0x112E_1 — relay an inline-keyboard-button click event to the bot
// owning the button (so the bot can react). All identity fields go on
// the wire as uint_64 → callers pass JS numbers and we widen here.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x112eReq, Oidb0x112eResp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface InlineButtonClickResult {
  [key: string]: import('@snowluma/common/json').JsonValue;
  result: number;
  errMsg: string;
  status: 0;
  promptText: string;
  promptType: 0;
  promptIcon: 0;
}

export namespace ClickInlineKeyboardButton {
  export const command = 0x112E;
  export const subCommand = 1;

  export interface Params {
    groupId: number;
    botAppid: number;
    buttonId: string;
    callbackData: string;
    msgSeq: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x112eReq => ({
    botAppid: BigInt(p.botAppid),
    msgSeq: BigInt(p.msgSeq),
    buttonId: String(p.buttonId),
    callbackData: String(p.callbackData || ''),
    unknown7: 0,
    groupId: BigInt(p.groupId),
    unknown9: 1,
  });

  export const deserialize = (_ctx: Deps, body: Oidb0x112eResp): InlineButtonClickResult => ({
    result: Number(body.result || 0),
    errMsg: body.errMsg || '',
    status: 0,
    promptText: body.promptText || '',
    promptType: 0,
    promptIcon: 0,
  });

  export const encode = (env: OidbBase<Oidb0x112eReq>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x112eReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x112eResp> =>
    protobuf_decode<OidbBase<Oidb0x112eResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<InlineButtonClickResult> =>
    invokeOidb(deps, ClickInlineKeyboardButton, params);
}
