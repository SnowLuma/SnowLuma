// action-kit — declarative OneBot Action definitions.
//
// One Action declares its param contract once (a record of `Field`s + optional
// cross-field `rules`) and a `run` handler. The kit owns param coercion +
// validation + the `BAD_REQUEST` shaping (naming the offending field) +
// doc metadata. The handler receives typed, already-validated params.
//
// Narrow seam (ADR-0006): `ApiHandler` keeps dispatch / try-catch / response
// wrapping. `defineAction(...).register(h, ctx)` ultimately registers a plain
// `(params) => Promise<ApiResponse>` via `ApiHandler.registerAction`, exactly
// like the legacy style — so old and new actions coexist during migration.
//
// Zero runtime npm deps (ADR-0004). Type inference via `InferParams` — no
// hand-written param interface. Param contract is intentionally a second
// definition from the SDK's client-side types (ADR-0005).
//
// Guard-rail (ADR-0007): the built-in coercers below are strict. Do NOT add a
// lenient `union`/`refine` escape that re-introduces the silent coercion this
// module exists to remove.

import { RETCODE, failedResponse } from './types';
import type { ApiResponse, JsonObject, JsonValue } from './types';
import type { ApiActionContext, ApiHandler } from './api-handler';

// ─────────────────────────── result currency ───────────────────────────

export type Ok<T> = { ok: true; value: T };
/** `field` is the offending param ('' for a cross-field rule). */
export type Err = { ok: false; field: string; reason: string };
export type CoerceResult<T> = Ok<T> | Err;

const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (field: string, reason: string): Err => ({ ok: false, field, reason });

/** Only an absent key produces MISSING — this is what lets a present `0` /
 *  `''` / `false` be distinguished from "not provided". */
const MISSING = Symbol('missing');
type Raw = JsonValue | typeof MISSING;

// ─────────────────────────── Field (param coercer) ───────────────────────────

export interface FieldDoc {
  type: string;
  required: boolean;
  default?: JsonValue;
  desc?: string;
  values?: readonly (string | number)[];
}

export interface Field<T> {
  readonly doc: FieldDoc;
  /** Coerce the raw value at this field's key (MISSING when the key is absent). */
  coerce(raw: Raw, field: string): CoerceResult<T>;
  /** Absent ⇒ value is `undefined`; a present value still must coerce. */
  optional(): Field<T | undefined>;
  /** Absent ⇒ `value`; a present value still must coerce (so `"abc"` for a
   *  numeric field is an error, not a silent fallback). */
  default(value: T): Field<T>;
  describe(text: string): Field<T>;
}

/** Core coerces a PRESENT value (never MISSING). Presence policy is applied
 *  by the wrapping Field. */
type Core<T> = (raw: JsonValue, field: string) => CoerceResult<T>;

class FieldImpl<T> implements Field<T> {
  constructor(
    private readonly core: Core<T>,
    readonly doc: FieldDoc,
  ) {}

  coerce(raw: Raw, field: string): CoerceResult<T> {
    if (raw === MISSING) {
      if (this.doc.required) return err(field, 'is required');
      return ok(this.doc.default as T); // default value, or undefined when optional
    }
    return this.core(raw, field);
  }

  optional(): Field<T | undefined> {
    return new FieldImpl<T | undefined>(this.core as Core<T | undefined>, {
      ...this.doc,
      required: false,
      default: undefined,
    });
  }

  default(value: T): Field<T> {
    return new FieldImpl<T>(this.core, { ...this.doc, required: false, default: value as JsonValue });
  }

  describe(text: string): Field<T> {
    return new FieldImpl<T>(this.core, { ...this.doc, desc: text });
  }
}

// ─────────────────────────── coercer vocabulary `f` ───────────────────────────

interface IntOpts { min?: number; max?: number; nonZero?: boolean }

/** Accept a number or numeric string, truncate to integer (matches the legacy
 *  `asNumber`), then apply bounds. Non-numeric / blank ⇒ Err. */
function intCore(typeName: string, opts: IntOpts): Core<number> {
  return (raw, field) => {
    let n: number;
    if (typeof raw === 'number' && Number.isFinite(raw)) n = Math.trunc(raw);
    else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) n = Math.trunc(Number(raw));
    else return err(field, `expected ${typeName}`);
    if (opts.nonZero && n === 0) return err(field, 'must not be 0');
    if (opts.min !== undefined && n < opts.min) return err(field, `must be >= ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) return err(field, `must be <= ${opts.max}`);
    return ok(n);
  };
}

interface StrOpts { allowEmpty?: boolean; maxLen?: number }

function arrayField<E>(el: Field<E>, mustBeNonEmpty: boolean): Field<E[]> & { nonEmpty(): Field<E[]> } {
  const core: Core<E[]> = (raw, field) => {
    if (!Array.isArray(raw)) return err(field, 'expected an array');
    const out: E[] = [];
    for (let i = 0; i < raw.length; i++) {
      const r = el.coerce(raw[i] as JsonValue, `${field}[${i}]`);
      if (!r.ok) return r;
      out.push(r.value);
    }
    if (mustBeNonEmpty && out.length === 0) return err(field, 'must not be empty');
    return ok(out);
  };
  const base = new FieldImpl<E[]>(core, { type: `${el.doc.type}[]`, required: true });
  return Object.assign(base, { nonEmpty: () => arrayField(el, true) });
}

export const f = {
  /** Positive integer (>0): group_id / user_id / message_id. */
  uint(): Field<number> {
    return new FieldImpl<number>(intCore('a positive integer', { min: 1 }), { type: 'uint', required: true });
  },
  /** Integer with optional bounds; allows 0 / negatives unless bounded.
   *  e.g. a duration where 0 is meaningful: `f.int({ min: 0 })`. */
  int(opts: IntOpts = {}): Field<number> {
    return new FieldImpl<number>(intCore('an integer', opts), { type: 'int', required: true });
  },
  /** OneBot message id: a non-zero integer. NEGATIVES ARE VALID (ids are a
   *  signed int32 hash) — do NOT use `uint()` for message_id. */
  messageId(): Field<number> {
    return new FieldImpl<number>(intCore('a message id', { nonZero: true }), { type: 'messageId', required: true });
  },
  /** Finite number (fractions allowed). */
  number(): Field<number> {
    return new FieldImpl<number>((raw, field) => {
      if (typeof raw === 'number' && Number.isFinite(raw)) return ok(raw);
      if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return ok(Number(raw));
      return err(field, 'expected a number');
    }, { type: 'number', required: true });
  },
  /** String. Numbers/booleans stringify (matches legacy `asString`). Empty
   *  allowed by default; `{ allowEmpty: false }` rejects ''. */
  string(opts: StrOpts = {}): Field<string> {
    return new FieldImpl<string>((raw, field) => {
      let s: string;
      if (typeof raw === 'string') s = raw;
      else if (typeof raw === 'number' || typeof raw === 'boolean') s = String(raw);
      else return err(field, 'expected a string');
      if (opts.allowEmpty === false && s === '') return err(field, 'must not be empty');
      if (opts.maxLen !== undefined && s.length > opts.maxLen) return err(field, `must be <= ${opts.maxLen} chars`);
      return ok(s);
    }, { type: 'string', required: true });
  },
  /** true/1/yes/on ⇒ true; false/0/no/off ⇒ false (matches legacy `asBoolean`). */
  bool(): Field<boolean> {
    return new FieldImpl<boolean>((raw, field) => {
      if (typeof raw === 'boolean') return ok(raw);
      if (typeof raw === 'number') return ok(raw !== 0);
      if (typeof raw === 'string') {
        const t = raw.trim().toLowerCase();
        if (t === 'true' || t === '1' || t === 'yes' || t === 'on') return ok(true);
        if (t === 'false' || t === '0' || t === 'no' || t === 'off') return ok(false);
      }
      return err(field, 'expected a boolean');
    }, { type: 'bool', required: true });
  },
  /** OneBot message union: string | segment[] | object. A string that looks
   *  like a JSON array is parsed (matches legacy `asMessage`); otherwise the
   *  value passes through. Output stays `JsonValue` — downstream ctx.* accept it. */
  message(): Field<JsonValue> {
    return new FieldImpl<JsonValue>((raw, _field) => {
      if (typeof raw === 'string') {
        const t = raw.trim();
        if (t.startsWith('[') && t.endsWith(']')) {
          try {
            const parsed: unknown = JSON.parse(t);
            if (Array.isArray(parsed)) return ok(parsed as JsonValue);
          } catch {
            // fall through to literal text
          }
        }
      }
      return ok(raw);
    }, { type: 'message', required: true });
  },
  /** Homogeneous array; `.nonEmpty()` rejects []. */
  array<E>(el: Field<E>): Field<E[]> & { nonEmpty(): Field<E[]> } {
    return arrayField(el, false);
  },
  /** Constrained literal set. */
  enum<const V extends readonly (string | number)[]>(...values: V): Field<V[number]> {
    return new FieldImpl<V[number]>((raw, field) => {
      if ((typeof raw === 'string' || typeof raw === 'number') && (values as readonly (string | number)[]).includes(raw)) {
        return ok(raw as V[number]);
      }
      return err(field, `expected one of: ${values.join(', ')}`);
    }, { type: 'enum', required: true, values });
  },
  /** Escape hatch — pass the raw value (or undefined) through, validate nothing. */
  raw(): Field<JsonValue | undefined> {
    return new FieldImpl<JsonValue | undefined>((raw) => ok(raw), { type: 'raw', required: false, default: undefined });
  },
};

// ─────────────────────────── type inference ───────────────────────────

type Spec = Record<string, Field<unknown>>;
type FieldType<F> = F extends Field<infer T> ? T : never;
/** Post-validation every key is present; optional/raw fields carry `undefined`
 *  in their value type. */
export type InferParams<S extends Spec> = { [K in keyof S]: FieldType<S[K]> };

// ─────────────────────────── cross-field rules ───────────────────────────

export interface CrossFieldRule {
  readonly doc: string;
  check(params: Record<string, unknown>): Err | null;
}

type Key<P> = Extract<keyof P, string>;
type Group<P> = Key<P> | Key<P>[];

export interface RuleBuilders<P> {
  /** Exactly one group satisfied. A group is a key, or an array of keys that
   *  must ALL be present. e.g. `exactlyOneOf('message_id', ['group_id','user_id'])`. */
  exactlyOneOf(...groups: Group<P>[]): CrossFieldRule;
  atLeastOneOf(...keys: Key<P>[]): CrossFieldRule;
  requiredTogether(...keys: Key<P>[]): CrossFieldRule;
  mutuallyExclusive(...keys: Key<P>[]): CrossFieldRule;
  /** Arbitrary predicate; fails with `doc` as the reason. */
  rule(doc: string, ok: (p: P) => boolean): CrossFieldRule;
}

const present = (p: Record<string, unknown>, key: string): boolean => p[key] !== undefined;
const groupOk = (p: Record<string, unknown>, g: string | string[]): boolean =>
  Array.isArray(g) ? g.every((k) => present(p, k)) : present(p, g);
const groupLabel = (g: string | string[]): string => (Array.isArray(g) ? `(${g.join('+')})` : g);

const RULES: RuleBuilders<Record<string, unknown>> = {
  exactlyOneOf(...groups) {
    const doc = `exactly one of: ${groups.map(groupLabel).join(' | ')}`;
    return {
      doc,
      check: (p) => (groups.filter((g) => groupOk(p, g)).length === 1 ? null : err('', doc)),
    };
  },
  atLeastOneOf(...keys) {
    const doc = `at least one of: ${keys.join(', ')}`;
    return { doc, check: (p) => (keys.some((k) => present(p, k)) ? null : err('', doc)) };
  },
  requiredTogether(...keys) {
    const doc = `all or none of: ${keys.join(', ')}`;
    return {
      doc,
      check: (p) => {
        const n = keys.filter((k) => present(p, k)).length;
        return n === 0 || n === keys.length ? null : err('', doc);
      },
    };
  },
  mutuallyExclusive(...keys) {
    const doc = `at most one of: ${keys.join(', ')}`;
    return { doc, check: (p) => (keys.filter((k) => present(p, k)).length <= 1 ? null : err('', doc)) };
  },
  rule(doc, okFn) {
    return { doc, check: (p) => (okFn(p as never) ? null : err('', doc)) };
  },
};

// ─────────────────────────── defineAction ───────────────────────────

export interface ParamDoc extends FieldDoc {
  name: string;
}
export interface ActionDoc {
  name: string;
  aliases: string[];
  summary?: string;
  returns?: string;
  params: ParamDoc[];
  invariants: string[];
}

type Handler = (params: JsonObject) => Promise<ApiResponse>;

export interface ActionSpec<S extends Spec> {
  readonly names: string[];
  readonly params: S;
  /** Pure: coerce + validate + cross-field, no ctx, no I/O. The test surface. */
  parse(raw: JsonObject): CoerceResult<InferParams<S>>;
  /** Bind ctx and produce the `(params) => ApiResponse` for `registerAction`. */
  toHandler(ctx: ApiActionContext): Handler;
  /** Doc metadata (D4); a renderer walks this. */
  describe(): ActionDoc;
  register(h: ApiHandler, ctx: ApiActionContext): void;
}

interface ActionDef<S extends Spec> {
  name: string | readonly [string, ...string[]];
  summary?: string;
  returns?: string;
  params: S;
  rules?: (r: RuleBuilders<InferParams<S>>) => readonly CrossFieldRule[];
  /** `raw` is the original untouched params — an escape hatch for the
   *  irregular tail (alias-key fallbacks, arbitrary nested objects). Declared
   *  fields in `p` remain the validated path; reach for `raw` only for keys
   *  the spec can't express. */
  run: (p: InferParams<S>, ctx: ApiActionContext, raw: JsonObject) => Promise<ApiResponse> | ApiResponse;
}

const wording = (e: Err): string => (e.field ? `${e.field}: ${e.reason}` : e.reason);

export function defineAction<S extends Spec>(def: ActionDef<S>): ActionSpec<S> {
  const names = typeof def.name === 'string' ? [def.name] : [...def.name];
  const rules: readonly CrossFieldRule[] = def.rules
    ? def.rules(RULES as unknown as RuleBuilders<InferParams<S>>)
    : [];

  const parse = (raw: JsonObject): CoerceResult<InferParams<S>> => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(def.params)) {
      const field = def.params[key];
      const value = Object.prototype.hasOwnProperty.call(raw, key) ? (raw[key] as JsonValue) : MISSING;
      const r = field.coerce(value, key);
      if (!r.ok) return r;
      out[key] = r.value;
    }
    for (const rule of rules) {
      const e = rule.check(out);
      if (e) return e;
    }
    return ok(out as InferParams<S>);
  };

  const toHandler = (ctx: ApiActionContext): Handler => async (params: JsonObject) => {
    const r = parse(params);
    if (!r.ok) return failedResponse(RETCODE.BAD_REQUEST, wording(r));
    return def.run(r.value, ctx, params);
  };

  return {
    names,
    params: def.params,
    parse,
    toHandler,
    describe: () => ({
      name: names[0],
      aliases: names.slice(1),
      summary: def.summary,
      returns: def.returns,
      params: Object.entries(def.params).map(([name, field]) => ({ name, ...field.doc })),
      invariants: rules.map((rule) => rule.doc),
    }),
    register: (h, ctx) => {
      const handler = toHandler(ctx);
      for (const name of names) h.registerAction(name, handler);
    },
  };
}

// ─────────────────────────── presets ───────────────────────────
// `group_id` appears in 61/142 actions, `user_id` in 27 — these collapse the
// dominant shape. The injected fields are surfaced in `describe()` so docs
// list them even though the caller never typed them (ADR-0006 trade-off).

type WithGroup<S extends Spec> = S & { group_id: Field<number> };
type WithGroupUser<S extends Spec> = S & { group_id: Field<number>; user_id: Field<number> };

interface PresetDef<S extends Spec, Extra> {
  name: string | readonly [string, ...string[]];
  summary?: string;
  returns?: string;
  params?: S;
  rules?: (r: RuleBuilders<InferParams<S> & Extra>) => readonly CrossFieldRule[];
  run: (p: InferParams<S> & Extra, ctx: ApiActionContext, raw: JsonObject) => Promise<ApiResponse> | ApiResponse;
}

/** Pre-seeds `group_id` (uint, required). */
export function groupAction<S extends Spec>(def: PresetDef<S, { group_id: number }>): ActionSpec<WithGroup<S>> {
  const params = { group_id: f.uint().describe('群号'), ...(def.params ?? {}) } as WithGroup<S>;
  return defineAction({ ...def, params } as unknown as ActionDef<WithGroup<S>>);
}

/** Pre-seeds `group_id` + `user_id` (both uint, required). */
export function groupUserAction<S extends Spec>(
  def: PresetDef<S, { group_id: number; user_id: number }>,
): ActionSpec<WithGroupUser<S>> {
  const params = {
    group_id: f.uint().describe('群号'),
    user_id: f.uint().describe('QQ 号'),
    ...(def.params ?? {}),
  } as WithGroupUser<S>;
  return defineAction({ ...def, params } as unknown as ActionDef<WithGroupUser<S>>);
}

// ─────────────────────────── registration helper ───────────────────────────

/** Register many specs onto an ApiHandler. Coexists with legacy
 *  `h.registerAction(name, fn)` in the same `register(h, ctx)`. */
export function registerActions(h: ApiHandler, ctx: ApiActionContext, specs: ReadonlyArray<ActionSpec<Spec>>): void {
  for (const spec of specs) spec.register(h, ctx);
}
