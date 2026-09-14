import { GetPskey } from '@snowluma/protocol/oidb-services/web/get-pskey';
import {
  getCollectionList,
  type CollectionListResult,
} from '@snowluma/protocol/web/collection';
import type { BridgeContext } from '../bridge-context';

const COLLECTION_DOMAIN = 'weiyun.com';

/** Read-only access to the account's QQ collection list. */
export class CollectionApi {
  constructor(private readonly ctx: BridgeContext) {}

  async list(category = 0, count = 50): Promise<CollectionListResult> {
    const { domainPskeyMap } = await GetPskey.invoke(this.ctx, {
      domainList: [COLLECTION_DOMAIN],
    });
    const pskey = domainPskeyMap.get(COLLECTION_DOMAIN);
    if (!pskey) throw new Error(`QQ did not return a p_skey for ${COLLECTION_DOMAIN}`);

    return getCollectionList({
      uin: this.ctx.identity.uin,
      pskey,
      category,
      count,
    });
  }
}
