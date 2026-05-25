// Cross-file fixture: imports the abstract base from `base-transformer.ts`
// and supplies the concrete sibling methods. The plugin's pipeline must
// resolve the extends edge across the file boundary via the TypeChecker
// and still emit per-subclass overrides here.
import type { int_32, pb } from '@snowluma/proton';
import { CrossFileBase } from './base-transformer';

export interface FooRequestPb {
  value: pb<1, int_32>;
}

export interface FooResponsePb {
  ok: pb<1, int_32>;
}

export interface FooRequest {
  value: number;
}

export interface FooResponse {
  ok: boolean;
}

export class FooTransformer extends CrossFileBase {
  static readonly command = 'foo.cmd';

  static build(_ctx: unknown, params: FooRequest): FooRequestPb {
    return { value: params.value };
  }

  static parse(_ctx: unknown, body: FooResponsePb): FooResponse {
    return { ok: (body.ok ?? 0) > 0 };
  }
}
