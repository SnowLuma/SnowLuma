import { assessAccessToken } from '@snowluma/common/access-token';
import type { OneBotConfig } from '@snowluma/onebot/types';
import { isLoopbackClientIp } from './client-ip';

function isLoopbackBindHost(host: string | undefined): boolean {
  const value = host?.trim().toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '') ?? '';
  if (!value) return false;
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  return isLoopbackClientIp(value);
}

export class OneBotAccessTokenPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OneBotAccessTokenPolicyError';
  }
}

export interface OneBotAccessTokenPolicyOptions {
  clientIp: string;
  uin: string;
}

type InboundKind = 'httpServers' | 'wsServers';

const INBOUND_KINDS: readonly InboundKind[] = ['httpServers', 'wsServers'];

function sameTokenAtPreviousIdentity(
  previous: OneBotConfig['networks'][InboundKind],
  next: OneBotConfig['networks'][InboundKind],
  nextName: string,
  nextToken: string,
  index: number,
): boolean {
  const named = previous.find((adapter) => adapter.name === nextName);
  if (named && (named.accessToken ?? '') === nextToken) return true;
  // Preserve a legacy token when the operator only renames the same list item.
  // Reordering keeps names stable and is covered by the lookup above.
  const sameIndex = previous[index];
  return sameIndex !== undefined
    && !next.some((adapter) => adapter.name === sameIndex.name)
    && (sameIndex.accessToken ?? '') === nextToken;
}

export function validateOneBotAccessTokenChanges(
  previous: OneBotConfig | null,
  next: OneBotConfig,
  options: OneBotAccessTokenPolicyOptions,
): void {
  const allowEmptyFromClient = isLoopbackClientIp(options.clientIp);
  for (const kind of INBOUND_KINDS) {
    const previousList = previous?.networks[kind] ?? [];
    const nextList = next.networks[kind];
    for (let index = 0; index < nextList.length; index += 1) {
      const adapter = nextList[index];
      const token = adapter.accessToken ?? '';
      if (sameTokenAtPreviousIdentity(previousList, nextList, adapter.name, token, index)) continue;

      if (!token) {
        if (!allowEmptyFromClient && !isLoopbackBindHost(adapter.host)) {
          throw new OneBotAccessTokenPolicyError(
            `节点“${adapter.name}”未绑定本机地址，远程保存必须填写令牌；请生成令牌或将主机改为 127.0.0.1。`,
          );
        }
        continue;
      }

      const host = adapter.host ?? '0.0.0.0';
      const assessment = assessAccessToken(token, [
        options.uin,
        adapter.name,
        kind,
        host,
        adapter.port,
      ]);
      if (assessment.reason === 'too-short') {
        throw new OneBotAccessTokenPolicyError(
          `节点“${adapter.name}”的令牌至少需要 16 个字符；请重新生成或继续补充。`,
        );
      }
      if (!assessment.acceptable) {
        throw new OneBotAccessTokenPolicyError(
          `节点“${adapter.name}”的令牌容易被猜中；请重新生成随机令牌。`,
        );
      }
    }
  }
}
