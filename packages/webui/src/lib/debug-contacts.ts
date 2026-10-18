import type { ApiClient } from '@/lib/api/types';
import type { PickerOption } from '@/components/ui/picker';

const TTL_MS = 5 * 60_000;
const LS_KEY = 'snowluma.debug.contacts.v1';

export function userAvatar(uin: string | number): string {
    return `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=100`;
}

export function groupAvatar(gid: string | number): string {
    return `https://p.qlogo.cn/gh/${gid}/${gid}/100`;
}

interface Entry {
    at: number;
    items: PickerOption[];
}

// Rebuild avatar URLs rather than storing them for every member.
function avatarFor(key: string, value: string): string | undefined {
    if (key.startsWith('groups:')) {
        return groupAvatar(value);
    }

    if (key.startsWith('friends:') || key.startsWith('members:')) {
        return userAvatar(value);
    }

    return undefined;
}

const mem = new Map<string, Entry>();
let hydrated = false;

function hydrate(): void {
    if (hydrated) {
        return;
    }

    hydrated = true;

    try {
        const raw = localStorage.getItem(LS_KEY);

        if (raw) {
            const obj = JSON.parse(raw) as Record<string, Entry>;

            for (const [k, v] of Object.entries(obj)) {
                if (v && Array.isArray(v.items)) {
                    mem.set(k, {
                        at: v.at,
                        items: v.items.map((it) => ({
                            ...it,
                            avatar: avatarFor(k, it.value),
                        })),
                    });
                }
            }
        }
    } catch {
        /* corrupt / unavailable — start empty */
    }
}

function persist(): void {
    try {
        const obj: Record<string, Entry> = {};

        // Strip the derivable avatar to keep the serialized blob small.
        for (const [k, v] of mem) {
            obj[k] = {
                at: v.at,
                items: v.items.map((it) => ({ value: it.value, label: it.label, sub: it.sub })),
            };
        }

        localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {
        /* quota / unavailable — memory cache still works */
    }
}

export type ContactKind = 'friends' | 'groups' | 'members';

export interface ContactListState {
    items: PickerOption[];
    loading: boolean;
    error: string | null;
}

const ACTIONS: Record<ContactKind, string> = {
    friends: 'get_friend_list',
    groups: 'get_group_list',
    members: 'get_group_member_list',
};

function parseContact(kind: ContactKind, row: unknown): PickerOption | null {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('联系人列表格式无效');
    }

    const fields = row as Record<string, unknown>;
    const id = kind === 'groups' ? fields.group_id : fields.user_id;

    if (id == null) {
        return null;
    }

    if (typeof id !== 'string' && typeof id !== 'number') {
        throw new Error('联系人 ID 格式无效');
    }

    const value = String(id);
    const names =
        kind === 'groups'
            ? [fields.group_name]
            : kind === 'friends'
              ? [fields.remark, fields.nickname]
              : [fields.card, fields.nickname];
    const label =
        names.find((name): name is string => typeof name === 'string' && name !== '') ?? value;
    return {
        value,
        label,
        sub: value,
        avatar: kind === 'groups' ? groupAvatar(value) : userAvatar(value),
    };
}

export function createContactList(
    invoke: ApiClient['debug']['invoke'],
    kind: ContactKind,
    uin: string,
    groupId = '',
) {
    hydrate();
    const key =
        uin && (kind !== 'members' || groupId)
            ? `${kind}:${uin}${kind === 'members' ? `:${groupId}` : ''}`
            : null;
    const cached = key ? mem.get(key) : undefined;
    let state: ContactListState = { items: cached?.items ?? [], loading: false, error: null };
    let revision = 0;
    const listeners = new Set<() => void>();

    function publish(next: ContactListState) {
        state = next;
        listeners.forEach((listener) => listener());
    }

    async function refresh(force = true): Promise<void> {
        const request = ++revision;

        if (!key) {
            return;
        }

        const hit = mem.get(key);

        if (!force && hit && Date.now() - hit.at < TTL_MS) {
            publish({ items: hit.items, loading: false, error: null });
            return;
        }

        publish({ ...state, loading: true, error: null });

        try {
            const result = await invoke(
                uin,
                ACTIONS[kind],
                kind === 'members' ? { group_id: groupId } : {},
            );

            if (request !== revision) {
                return;
            }

            if (result.status !== 'ok') {
                throw new Error(result.message || result.wording || '加载失败');
            }

            if (!Array.isArray(result.data)) {
                throw new Error('联系人列表格式无效');
            }

            const items = result.data
                .map((row) => parseContact(kind, row))
                .filter((item) => item !== null);
            mem.set(key, { at: Date.now(), items });
            persist();
            publish({ items, loading: false, error: null });
        } catch (error) {
            if (request === revision) {
                publish({
                    ...state,
                    loading: false,
                    error: error instanceof Error ? error.message : '加载失败',
                });
            }
        }
    }

    return {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        refresh,
        invalidate: () => {
            revision += 1;
        },
    };
}
