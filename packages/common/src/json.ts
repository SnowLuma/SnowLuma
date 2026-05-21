// Plain JSON value types — defined here (not in @snowluma/onebot/types
// where they used to live) so @snowluma/bridge can talk about JSON-shaped
// payloads without importing OneBot. The OneBot types module keeps the
// names exported via re-export, so existing call sites that say
// `import type { JsonValue } from '<…>/onebot/types'` continue to work
// unchanged after Phase 3.
//
// Anything actually OneBot-specific (ApiResponse, OneBotRequest, …)
// stays in @snowluma/onebot — only the plain JSON quartet moves here.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonArray = JsonValue[];
