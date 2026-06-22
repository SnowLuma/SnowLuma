import type { BridgeInterface } from '@snowluma/core/bridge-interface';

export async function handleGroupAddRequest(
  bridge: BridgeInterface,
  flag: string,
  approve: boolean,
  reason: string,
): Promise<void> {
  // flag format: "add:groupId:uid" or "invite:groupId:uid"
  const parts = flag.split(':');
  if (parts.length < 3) throw new Error('invalid group request flag');
  const requestType = parts[0];
  const groupId = parseInt(parts[1], 10);
  const targetUid = parts.slice(2).join(':');
  if (!groupId) throw new Error('invalid group_id in flag');
  if (!targetUid) throw new Error('invalid request target in flag');

  // Bot self-invited via a private "qun.invite" card: the only sequence the
  // server accepts at 0x10c8_1 is that card's jumpUrl msgseq, with eventType=2
  // / filtered=false. The fetchGroupRequests tuple below fails this case with
  // 120161001 ("handle async message fail"). See issue #125.
  if (requestType === 'invite') {
    const cardSequence = bridge.apis.contacts.getGroupInviteCardSequence(groupId);
    if (cardSequence) {
      await bridge.apis.groupAdmin.setAddRequest(groupId, cardSequence, 2, approve, reason, false);
      return;
    }
  }

  const requests = await bridge.apis.contacts.fetchGroupRequests();
  const matching = requests.find((r) => {
    if (r.groupId !== groupId) return false;
    if (requestType === 'add') return r.targetUid === targetUid;
    if (requestType === 'invite') return r.invitorUid === targetUid;
    return false;
  }) || requests.find(r => r.groupId === groupId);

  if (!matching) {
    throw new Error('matching group request not found');
  }
  await bridge.apis.groupAdmin.setAddRequest(
    groupId,
    matching.sequence,
    matching.eventType,
    approve,
    reason,
    matching.filtered,
  );
}
