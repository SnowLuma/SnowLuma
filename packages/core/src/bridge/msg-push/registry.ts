// MsgPushRegistry — per-PkgType dispatch table. Each PkgType maps to a single
// decoder; double-registration is a programming error (throws at register time).
// Decoder errors are caught and logged with the PkgType so a single bad decoder
// can never silently take down sibling decoders sharing the cmd.

import { createLogger } from '../../utils/logger';
import type { QQEventVariant } from '../events';
import type { MsgPushContext } from './context';
import type { PkgType } from './enums';

const log = createLogger('MsgPush');

export type MsgPushDecoder = (ctx: MsgPushContext) => QQEventVariant[];

export class MsgPushRegistry {
  private readonly decoders_ = new Map<PkgType, MsgPushDecoder>();

  register(pkgType: PkgType | PkgType[], decoder: MsgPushDecoder): void {
    const list = Array.isArray(pkgType) ? pkgType : [pkgType];
    for (const t of list) {
      if (this.decoders_.has(t)) {
        throw new Error(`MsgPushRegistry: PkgType ${t} already registered`);
      }
      this.decoders_.set(t, decoder);
    }
  }

  decode(ctx: MsgPushContext): QQEventVariant[] {
    const decoder = this.decoders_.get(ctx.head.msgType as PkgType);
    if (!decoder) return [];
    try {
      return decoder(ctx);
    } catch (e) {
      log.error('decoder error for PkgType=%d subType=%d: %s',
        ctx.head.msgType, ctx.head.subType,
        e instanceof Error ? (e.stack ?? e.message) : String(e));
      return [];
    }
  }
}
