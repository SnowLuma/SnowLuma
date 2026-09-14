import type { JsonObject } from '../types';
import type { ConverterContext } from './index';

// The OneBot post header every converted event shares: `time` + `self_id` +
// `post_type`. Previously each of the ~17 converters hand-wrote it, so the
// shared shape could drift. These builders concentrate it — a converter just
// supplies its `post_type`-specific fields.

type Timed = { time: number };

/** notice envelope — `{ time, self_id, post_type: 'notice', ...fields }`. */
export function notice(ctx: ConverterContext, event: Timed, fields: JsonObject): JsonObject {
  return { time: event.time, self_id: ctx.selfId, post_type: 'notice', ...fields };
}

/** request envelope — `{ time, self_id, post_type: 'request', ...fields }`. */
export function request(ctx: ConverterContext, event: Timed, fields: JsonObject): JsonObject {
  return { time: event.time, self_id: ctx.selfId, post_type: 'request', ...fields };
}

/**
 * message envelope — `{ time, self_id, post_type, ...fields }`. `postType` is
 * 'message' or 'message_sent' (self-echo), decided per-message by the caller.
 */
export function message(ctx: ConverterContext, event: Timed, postType: string, fields: JsonObject): JsonObject {
  return { time: event.time, self_id: ctx.selfId, post_type: postType, ...fields };
}
