import { createLogger } from '../../utils/logger';
import type { QQEventVariant } from '../events';
import type { MsgPushContext } from './context';
import type { PkgType } from './enums';

const log = createLogger('MsgPush');
const unknownLog = createLogger('MsgPush.Unknown');

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
    if (!decoder) {
      // Unrecognized PkgType: either we don't care about this notify, or
      // the QQ NT client added a new variant. Surface at debug so a
      // protocol change can be spotted without spamming production logs.
      unknownLog.debug('no decoder for PkgType=%d subType=%d', ctx.head.msgType, ctx.head.subType);
      return [];
    }
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
