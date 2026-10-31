const PAIR_WINDOW_MS = 3_000;
const MAX_INVITES = 1_024;

interface Card {
    groupId: number;
    sequence: number;
}

interface SelfInviteNotice {
    cardSequence?: number;
    ambiguous?: boolean;
}

interface UnpairedInvite {
    key: string;
    notice?: SelfInviteNotice;
    source: 'card' | 'notice';
    expiresAt: number;
}

function remember<T>(entries: Map<string, T>, key: string, value: T): void {
    entries.delete(key);

    if (entries.size >= MAX_INVITES) {
        const oldest = entries.keys().next();

        if (!oldest.done) {
            entries.delete(oldest.value);
        }
    }

    entries.set(key, value);
}

/** Account-local state shared by incoming invitations and their approval actions. */
export class GroupInviteTracker {
    private readonly cards = new Map<string, Card>();
    private readonly notices = new Map<string, SelfInviteNotice>();
    private unpaired: UnpairedInvite[] = [];

    receiveNotice(groupId: number, uid: string): boolean {
        const key = `${groupId}:${uid}`;
        const notice: SelfInviteNotice = {};

        if (this.pair(key, 'notice', notice)) {
            return false;
        }

        // Earlier notices with the same legacy flag cannot lend this one their card.
        remember(this.notices, key, notice);
        return true;
    }

    receiveCard(groupId: number, sequence: number, uid?: string): boolean {
        const key = `${groupId}:${sequence}`;

        if (this.cards.has(key)) {
            return false;
        }

        const paired = uid ? this.pair(`${groupId}:${uid}`, 'card') : undefined;

        if (paired?.notice) {
            paired.notice.cardSequence = sequence;
        }

        remember(this.cards, key, { groupId, sequence });
        return !paired;
    }

    private pair(
        key: string,
        source: UnpairedInvite['source'],
        notice?: SelfInviteNotice,
    ): UnpairedInvite | undefined {
        const now = Date.now();
        this.unpaired = this.unpaired.filter((entry) => entry.expiresAt > now);
        const match = this.unpaired.findIndex(
            (entry) => entry.key === key && entry.source !== source,
        );

        if (match !== -1) {
            return this.unpaired.splice(match, 1)[0];
        }

        if (this.unpaired.length >= MAX_INVITES) {
            this.unpaired.shift();
        }

        if (
            notice &&
            this.unpaired.some((entry) => entry.key === key && entry.source === 'notice')
        ) {
            notice.ambiguous = true;
        }

        this.unpaired.push({ key, source, notice, expiresAt: now + PAIR_WINDOW_MS });
        return undefined;
    }

    getSelfInviteNotice(groupId: number, uid: string): Readonly<SelfInviteNotice> | undefined {
        const notice = this.notices.get(`${groupId}:${uid}`);

        if (notice?.ambiguous) {
            throw new Error('multiple pending self invitations share this flag');
        }

        return notice;
    }

    getCardSequence(groupId: number): number | undefined {
        let sequence: number | undefined;

        for (const card of this.cards.values()) {
            if (card.groupId === groupId) {
                sequence = card.sequence;
            }
        }

        return sequence;
    }

    findCardGroup(sequence: number, groupId?: number): number | undefined {
        if (groupId !== undefined) {
            return this.cards.get(`${groupId}:${sequence}`)?.groupId;
        }

        let match: number | undefined;

        for (const card of this.cards.values()) {
            if (card.sequence === sequence) {
                if (match !== undefined) {
                    throw new Error('multiple groups match this invitation card sequence');
                }

                match = card.groupId;
            }
        }

        return match;
    }
}
