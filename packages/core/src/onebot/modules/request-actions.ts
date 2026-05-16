import type { BridgeInterface } from '../../bridge/bridge-interface';

export async function handleGroupAddRequest(
  bridge: BridgeInterface,
  flag: string,
  approve: boolean,
  reason: string,
): Promise<void> {
  // flag format: "add:groupId:uid" or "invite:groupId:uid" (from event-converter)
  const parts = flag.split(':');
  if (parts.length < 3) throw new Error('invalid group request flag');
  const groupId = parseInt(parts[1], 10);
  if (!groupId) throw new Error('invalid group_id in flag');

  const requests = await bridge.fetchGroupRequests();
  const matching = requests.find(r => r.groupId === groupId);
  if (!matching) {
    throw new Error('matching group request not found');
  }

  await bridge.setGroupAddRequest(
    groupId,
    matching.sequence,
    matching.eventType,
    approve,
    reason,
    matching.filtered,
  );
}
