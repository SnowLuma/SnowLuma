/**
 * Shared types for the SnowLuma Pixiv plugin.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Author: 希儿 (shiYuPIay) / SnowLuma 适配
 */
import type { AnyMessageSegment } from '@snowluma/sdk/types';
/** Pixiv illustration descriptor returned by the third-party API. */
export interface PixivIllust {
    pid: number;
    title: string;
    author: string;
    tags: string[];
    url: string;
    r18: boolean;
}
/** Pixiv daily-ranking item (richer than the search/recommend item). */
export interface PixivRankingIllust {
    id: number;
    title: string;
    author: string;
    bookmarks: number;
    tags: string[];
    proxyUrl: string;
}
/** Health-check result for the status command. */
export interface ApiHealth {
    lolicon: boolean;
    ranking: boolean;
}
/** A forward node built from an illust (search / recommend). */
export interface ForwardNode {
    illust: PixivIllust;
    isGroup: boolean;
    botId?: number;
}
/** Outgoing message alias for clarity. */
export type OutgoingMessage = AnyMessageSegment | AnyMessageSegment[] | string;
/** Result of a config validation pass. */
export interface ConfigValidationResult {
    ok: boolean;
    errors: string[];
}
/** A single configurable option descriptor (replaces NapCat WebUI schema). */
export interface ConfigField<T = unknown> {
    key: string;
    label: string;
    type: 'boolean' | 'text' | 'number';
    default: T;
    description: string;
    min?: number;
    max?: number;
    placeholder?: string;
}
//# sourceMappingURL=types.d.ts.map