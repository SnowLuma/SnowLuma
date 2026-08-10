export type GroupMessageFilterMode = 'blacklist' | 'whitelist';

export interface GroupMessageFilterConfig {
  mode: GroupMessageFilterMode;
  groupIds: number[];
}

export interface GroupIdParseResult {
  groupIds: number[];
  error?: string;
}

export function parseGroupIdsInput(value: string): GroupIdParseResult {
  const text = value.trim();
  if (!text) return { groupIds: [] };

  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const seen = new Set<number>();
  const groupIds: number[] = [];

  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      return { groupIds: [], error: `群号“${token}”格式不正确` };
    }
    const id = Number(token);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { groupIds: [], error: `群号“${token}”不是有效正整数` };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    groupIds.push(id);
  }

  return { groupIds };
}

export function formatGroupIdsInput(groupIds: number[]): string {
  return groupIds.join(', ');
}
