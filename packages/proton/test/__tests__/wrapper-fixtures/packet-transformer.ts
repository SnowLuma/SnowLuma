// Fixture for the subclass-wrapper TypeChecker pipeline tests.
// Mirrors the user's PacketTransformer pattern verbatim so the resolver +
// override generator can be exercised end-to-end.
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { int_32, pb } from '@snowluma/proton';

export interface StaticPacketTransformer<RPCParams, RPCResult, Params, Result> {
  readonly command: string;
  serialize(ctx: unknown, params: Params): RPCParams;
  deserialize(ctx: unknown, body: RPCResult): Result;
}

export abstract class PacketTransformer {
  static encode<
    R,
    T extends { serialize: (ctx: unknown, params: never) => R }
  >(
    this: T,
    ctx: unknown,
    params: T['serialize'] extends (ctx: unknown, p: infer P) => R ? P : never,
  ) {
    const rpcData = this.serialize(ctx, params as never);
    return protobuf_encode<R>(rpcData);
  }

  static decode<
    B,
    Res,
    T extends { deserialize: (ctx: unknown, body: B) => Res }
  >(
    this: T,
    ctx: unknown,
    bytes: Uint8Array,
  ): Res {
    const oIdbPackage = protobuf_decode<B>(bytes);
    return this.deserialize(ctx, oIdbPackage);
  }
}

interface rsq {
  param: number;
}
interface rsq_pb {
  param: pb<3, int_32>;
  id: pb<1, int_32>;
}
interface rps {
  result: number;
}
interface rps_pb {
  result: pb<1, int_32>;
  id: pb<2, int_32>;
}

export class DemoTransformer extends PacketTransformer {
  static readonly command = 'trpc.qq_new_tech.OidbSvcTrpcTcp.0x112e_1';

  static serialize(_ctx: unknown, params: rsq): rsq_pb {
    return {
      param: params.param,
      id: 123,
    };
  }

  static deserialize(_ctx: unknown, body: rps_pb): rps {
    console.log('Deserializing response with id:', body.id);
    return {
      result: body.result || 0,
    };
  }
}

DemoTransformer.encode(undefined, { param: 42 });
