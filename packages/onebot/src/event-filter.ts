import type { JsonObject, JsonValue, MessageFormat } from './types';
export interface EventReportOptions {
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}

export function resolveReportOptions(
  network: { messageFormat?: MessageFormat; reportSelfMessage?: boolean },
): EventReportOptions {
  return {
    messageFormat: network.messageFormat ?? 'array',
    reportSelfMessage: network.reportSelfMessage ?? false,
  };
}

export interface DispatchPayload {
  isSelfMessage: boolean;
  arrayJson: string;
  stringJson: string;
}

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

export function pickDispatchJson(
  payload: DispatchPayload,
  options: EventReportOptions,
): string | null {
  if (payload.isSelfMessage && !options.reportSelfMessage) return null;
  return options.messageFormat === 'string' ? payload.stringJson : payload.arrayJson;
}

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
