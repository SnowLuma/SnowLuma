// Debug contacts data layer — lazy-loads friend / group / member lists for the
// debug console's pickers via the read-only OneBot actions, with a shared
// module-level cache persisted to localStorage (version-stamped) and a short
// TTL. Every loader degrades gracefully: on error the hook returns the error so
// the Picker can fall back to raw input. One cache is shared across every
// picker instance (tester form, message builder, etc.).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import type { PickerOption } from '@/components/ui/picker';

const CACHE_VERSION = 1; // bump to invalidate all persisted entries
const TTL_MS = 5 * 60_000;
const LS_KEY = `snowluma.debug.contacts.v${CACHE_VERSION}`;

export function userAvatar(uin: string | number): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=100`;
}
export function groupAvatar(gid: string | number): string {
  return `https://p.qlogo.cn/gh/${gid}/${gid}/100`;
}

interface Entry { at: number; items: PickerOption[] }

// Avatars are derivable from the id + the list kind (encoded in the cache-key
// prefix), so they're stripped before persisting (a big member list × long
// avatar URLs would otherwise blow the ~5MB localStorage quota and silently
// kill persistence for ALL entries) and regenerated on hydrate.
function avatarFor(key: string, value: string): string | undefined {
  if (key.startsWith('groups:')) return groupAvatar(value);
  if (key.startsWith('friends:') || key.startsWith('members:')) return userAvatar(value);
  return undefined;
}

// ── shared cache (module-level, hydrated from localStorage once) ──
const mem = new Map<string, Entry>();
let hydrated = false;
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, Entry>;
      for (const [k, v] of Object.entries(obj)) {
        if (v && Array.isArray(v.items)) {
          mem.set(k, { at: v.at, items: v.items.map((it) => ({ ...it, avatar: it.avatar ?? avatarFor(k, it.value) })) });
        }
      }
    }
  } catch { /* corrupt / unavailable — start empty */ }
}
function persist(): void {
  try {
    const obj: Record<string, Entry> = {};
    // Strip the derivable avatar to keep the serialized blob small.
    for (const [k, v] of mem) obj[k] = { at: v.at, items: v.items.map((it) => ({ value: it.value, label: it.label, sub: it.sub })) };
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch { /* quota / unavailable — memory cache still works */ }
}

/** Drop every cached contact list (the data layer's "清缓存" button). */
export function clearDebugContactsCache(): void {
  mem.clear();
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

type ParseRow = (row: Record<string, unknown>) => PickerOption | null;

interface ListState {
  items: PickerOption[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function useContactList(cacheKey: string | null, action: string, uin: string, params: Record<string, unknown>, parse: ParseRow): ListState {
  const api = useApi();
  hydrate();
  const [items, setItems] = useState<PickerOption[]>(() => (cacheKey && mem.get(cacheKey)?.items) || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async (force: boolean) => {
    if (!cacheKey || !uin) return;
    const cached = mem.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < TTL_MS) {
      setItems(cached.items);
      return;
    }
    const myId = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.debug.invoke(uin, action, params);
      if (myId !== reqId.current) return; // superseded
      if (res.status !== 'ok') throw new Error(res.message || res.wording || '加载失败');
      const arr = Array.isArray(res.data) ? (res.data as Record<string, unknown>[]) : [];
      const mapped = arr.map(parse).filter((x): x is PickerOption => x !== null);
      mem.set(cacheKey, { at: Date.now(), items: mapped });
      persist();
      setItems(mapped);
    } catch (e) {
      if (myId !== reqId.current) return;
      setError(e instanceof Error ? e.message : '加载失败');
      // keep any stale items visible as a fallback
    } finally {
      if (myId === reqId.current) setLoading(false);
    }
    // params + parse are stable per call-site (their identity is captured by
    // cacheKey, which already varies on uin/group), so excluding them is
    // deliberate — including the fresh object/closure would reload every render.
  }, [api, cacheKey, uin, action]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cacheKey || !uin) { setItems([]); return; }
    const cached = mem.get(cacheKey);
    // Clear stale items when switching to an uncached key — otherwise the picker
    // would show the previous account/group's contacts as valid until the fetch
    // returns (a member-selection hazard).
    setItems(cached ? cached.items : []);
    void load(false);
  }, [cacheKey, uin, load]);

  return { items, loading, error, refresh: () => void load(true) };
}

export function useFriends(uin: string): ListState {
  return useContactList(
    uin ? `friends:${uin}` : null,
    'get_friend_list',
    uin,
    {},
    (r) => {
      const id = r.user_id;
      if (id == null) return null;
      const v = String(id);
      const nick = (r.remark as string) || (r.nickname as string) || v;
      return { value: v, label: nick, sub: v, avatar: userAvatar(v) };
    },
  );
}

export function useGroups(uin: string): ListState {
  return useContactList(
    uin ? `groups:${uin}` : null,
    'get_group_list',
    uin,
    {},
    (r) => {
      const id = r.group_id;
      if (id == null) return null;
      const v = String(id);
      return { value: v, label: (r.group_name as string) || v, sub: v, avatar: groupAvatar(v) };
    },
  );
}

export function useGroupMembers(uin: string, groupId: string): ListState {
  const gid = groupId.trim();
  return useContactList(
    uin && gid ? `members:${uin}:${gid}` : null,
    'get_group_member_list',
    uin,
    { group_id: gid },
    (r) => {
      const id = r.user_id;
      if (id == null) return null;
      const v = String(id);
      const name = (r.card as string) || (r.nickname as string) || v;
      return { value: v, label: name, sub: v, avatar: userAvatar(v) };
    },
  );
}
