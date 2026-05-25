// Cross-file fixture: the abstract base lives in this module and is
// imported + extended by `subclass-transformer.ts`. Exercises the
// TypeChecker's ability to walk an extends chain across file boundaries.
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

export abstract class CrossFileBase {
  static enc<R, T extends { build: (ctx: unknown, p: never) => R }>(
    this: T,
    ctx: unknown,
    params: T['build'] extends (ctx: unknown, p: infer P) => R ? P : never,
  ): Uint8Array {
    const payload = (this as unknown as { build: (c: unknown, p: never) => R }).build(ctx, params as never);
    return protobuf_encode<R>(payload);
  }

  static dec<B, Res, T extends { parse: (ctx: unknown, body: B) => Res }>(
    this: T,
    ctx: unknown,
    bytes: Uint8Array,
  ): Res {
    const decoded = protobuf_decode<B>(bytes);
    return (this as unknown as { parse: (c: unknown, b: B) => Res }).parse(ctx, decoded);
  }
}
