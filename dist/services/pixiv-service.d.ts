/**
 * Pixiv third-party API service.
 *
 * 通过 lolicon.app / obfs.dev 第三方聚合接口获取插画信息。
 * 该模块与运行时（NapCat / SnowLuma）无关，可原样复用。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Author: 希儿 (shiYuPIay)
 */
import type { ApiHealth, PixivIllust, PixivRankingIllust } from '../types.js';
/** 根据关键词搜索插画。 */
export declare function searchIllusts(tag: string, num: number, allowR18: boolean): Promise<PixivIllust[]>;
/** 获取随机推荐插画。 */
export declare function recommendIllusts(num: number, allowR18: boolean): Promise<PixivIllust[]>;
/** 检查第三方接口健康状态。 */
export declare function checkApiHealth(): Promise<ApiHealth>;
/** 获取 Pixiv 日榜数据。 */
export declare function fetchDailyRanking(num?: number): Promise<PixivRankingIllust[]>;
//# sourceMappingURL=pixiv-service.d.ts.map