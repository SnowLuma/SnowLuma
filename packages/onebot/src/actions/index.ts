// Action registry barrel — the single source of "which files contribute which
// actions", replacing three hand-synced lists that had to stay in lock-step:
//   1. ApiHandler's 12 `register as registerX` imports + 12 constructor calls,
//   2. each file's `export function register(h, ctx)` footer,
//   3. action-docs' own 13 imports + GROUPS array.
// Adding an action file now means editing exactly one place: ACTION_GROUPS.
//
// "Source file = domain category" is the existing convention (see action-docs),
// so the category label lives here too, making ACTION_GROUPS serve both runtime
// registration (via ALL_ACTIONS) and the doc collector (via the groups).

import type { RegisteredActionSpec } from '../action-kit';
import { actions as infoActions } from './info';
import { actions as messageActions } from './message';
import { actions as friendActions } from './friend';
import { actions as groupInfoActions } from './group-info';
import { actions as groupAdminActions } from './group-admin';
import { actions as groupFileActions } from './group-file';
import { actions as requestActions } from './request';
import { actions as extendedActions } from './extended';
import { actions as groupAlbumActions } from './group-album';
import { actions as qzoneActions } from './qzone';
import { actions as streamFileActions } from './stream-file';
import { actions as streamDownloadActions } from './stream-download';

export interface ActionGroup {
  /** Domain category (= source file), surfaced to the MCP / UI for grouping. */
  readonly category: string;
  readonly actions: readonly RegisteredActionSpec[];
}

/** Every action, grouped by domain category. The single source of truth. */
export const ACTION_GROUPS: readonly ActionGroup[] = [
  { category: '信息', actions: infoActions },
  { category: '消息', actions: messageActions },
  { category: '好友', actions: friendActions },
  { category: '群信息', actions: groupInfoActions },
  { category: '群管理', actions: groupAdminActions },
  { category: '群文件', actions: groupFileActions },
  { category: '请求', actions: requestActions },
  { category: '扩展', actions: extendedActions },
  { category: '群相册', actions: groupAlbumActions },
  { category: '空间', actions: qzoneActions },
  { category: '流式接口', actions: [...streamFileActions, ...streamDownloadActions] },
];

/** Flat list of every action spec, for one-shot registration onto an ApiHandler. */
export const ALL_ACTIONS: readonly RegisteredActionSpec[] = ACTION_GROUPS.flatMap((g) => g.actions);
