import type { JsonObject, JsonValue, MessageFormat } from './types';
export interface EventReportOptions {
  /** Effective `messageFormat` for this adapter. */
  messageFormat: MessageFormat;
  /** Whether self-sent messages should be forwarded to this adapter. */
  reportSelfMessage: boolean;
}

/**
 * Extract the dispatch options from an adapter. Each adapter is fully
 * self-describing — there is no global fallback. Defaults are applied here
 * only as a safety net for partially-deserialized legacy configs.
 */
export function resolveReportOptions(
  network: { messageFormat?: MessageFormat; reportSelfMessage?: boolean },
): EventReportOptions {
  return {
    messageFormat: network.messageFormat ?? 'array',
    reportSelfMessage: network.reportSelfMessage ?? false,
  };
}

/**
 * Pre-built payload covering every adapter variant of a single canonical event.
 *
 * The bridge produces one OneBot-shaped event per upstream packet. Because
 * adapters only differ in (a) whether they receive `message_sent` self-events
 * and (b) whether the `message` field is the segment array or its CQ-string
 * form, we serialize the event at most twice up-front and let every adapter
 * pick the slot it needs in O(1).
 */
export interface DispatchPayload {
  /** True when the canonical event is a self-sent message (`post_type='message_sent'`). */
  isSelfMessage: boolean;
  /** JSON for adapters using `messageFormat: 'array'` (the canonical event). */
  arrayJson: string;
  /**
   * JSON for adapters using `messageFormat: 'string'`. For non-message events
   * this points at the same string as `arrayJson` (no transformation needed).
   */
  stringJson: string;
}

/**
 * Build the dispatch payload for one canonical OneBot event. Performs at most
 * two `JSON.stringify` calls (one per format variant) regardless of how many
 * adapters the payload will fan out to.
 */
export function buildDispatchPayload(event: JsonObject): DispatchPayload {
  const isSelfMessage = event.post_type === 'message_sent';
  const arrayJson = JSON.stringify(event);

  let stringJson = arrayJson;
  const hasMessage = event.post_type === 'message' || event.post_type === 'message_sent';
  if (hasMessage && Array.isArray(event.message)) {
    const raw = typeof event.raw_message === 'string' ? event.raw_message : '';
    stringJson = JSON.stringify({ ...event, message: raw as JsonValue });
  }

  return { isSelfMessage, arrayJson, stringJson };
}

/**
 * Pick the pre-serialized payload variant an adapter should send, or `null`
 * when the adapter chose not to receive this event. Hot-path helper: one
 * branch + one map lookup per connection, no allocation.
 */
export function pickDispatchJson(
  payload: DispatchPayload,
  options: EventReportOptions,
): string | null {
  if (payload.isSelfMessage && !options.reportSelfMessage) return null;
  return options.messageFormat === 'string' ? payload.stringJson : payload.arrayJson;
}

/**
 * One-shot variant of {@link buildDispatchPayload} + {@link pickDispatchJson}
 * for ad-hoc events (e.g. WS connection bootstrap meta events) that aren't
 * worth pre-building a full payload for.
 *
 * Returns `null` when the adapter shouldn't see this event. Otherwise returns
 * the original event untouched, or a shallow clone with `message` rewritten.
 */
export function shapeEventForAdapter(
  event: JsonObject,
  options: EventReportOptions,
): JsonObject | null {
  if (event.post_type === 'message_sent' && !options.reportSelfMessage) return null;

  if (options.messageFormat === 'string'
    && (event.post_type === 'message' || event.post_type === 'message_sent')
    && Array.isArray(event.message)
  ) {
    const raw = typeof event.raw_message === 'string' ? event.raw_message : '';
    return { ...event, message: raw as JsonValue };
  }

  return event;
}
