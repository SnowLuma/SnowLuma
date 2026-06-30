// ParamField — renders the right smart control for one action param, driven by
// its semantic `role` first, then its coercion `type`, with the plain typed
// input as the floor. This is what kills "hand-write the JSON": a group_id
// becomes a group picker, a member_id a member picker linked to the sibling
// group_id, an image a FileSource, a bool a switch, an enum a select.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Picker } from '@/components/ui/picker';
import { FaceGrid } from '@/components/ui/face-grid';
import { FileSource } from '@/components/debug/file-source';
import { Segmented } from '@/components/debug/segmented';
import { MessageBuilder, toOneBot, type Seg } from '@/components/debug/message-builder';
import { useFriends, useGroups, useGroupMembers } from '@/hooks/use-debug-contacts';
import type { DebugActionParam, FieldRole } from '@/types';

const isNumericType = (t: string) => /int|uint|number|messageId/i.test(t);
const looksLikeId = (s: string) => /^\d{3,}$/.test(s.trim());

function GroupPicker({ uin, value, onChange }: { uin: string; value: string; onChange: (v: string) => void }) {
  const { items, loading, error, refresh } = useGroups(uin);
  return <Picker ariaLabel="选择群" value={value} onChange={onChange} options={items} loading={loading} error={error} onRefresh={refresh} placeholder="选择群…" validateRaw={looksLikeId} />;
}

function FriendPicker({ uin, value, onChange }: { uin: string; value: string; onChange: (v: string) => void }) {
  const { items, loading, error, refresh } = useFriends(uin);
  return <Picker ariaLabel="选择好友" value={value} onChange={onChange} options={items} loading={loading} error={error} onRefresh={refresh} placeholder="选择好友…" validateRaw={looksLikeId} />;
}

function MemberPicker({ uin, groupId, value, onChange }: { uin: string; groupId: string; value: string; onChange: (v: string) => void }) {
  const { items, loading, error, refresh } = useGroupMembers(uin, groupId);
  return (
    <Picker
      ariaLabel="选择群成员"
      value={value}
      onChange={onChange}
      options={items}
      loading={loading}
      error={error}
      onRefresh={refresh}
      placeholder={groupId ? '选择群成员…' : '请先选择群号'}
      validateRaw={looksLikeId}
    />
  );
}

const MEDIA_ROLES: FieldRole[] = ['file', 'image', 'record', 'video'];

export function ParamField({ param, value, onChange, uin, groupContext }: {
  param: DebugActionParam;
  value: string;
  onChange: (v: string) => void;
  uin: string;
  /** value of the sibling group_id field (for member_id pickers). */
  groupContext: string;
}) {
  const role = param.role;

  // ── role-driven widgets ──
  if (role === 'group_id') return <GroupPicker uin={uin} value={value} onChange={onChange} />;
  if (role === 'user_id') return <FriendPicker uin={uin} value={value} onChange={onChange} />;
  if (role === 'member_id') return <MemberPicker uin={uin} groupId={groupContext} value={value} onChange={onChange} />;
  if (role && MEDIA_ROLES.includes(role)) return <FileSource role={role} value={value} onChange={onChange} />;
  if (role === 'face_id') return <FaceGrid value={value} onChange={onChange} />;
  if (role === 'timestamp') {
    // datetime-local <-> unix seconds
    const local = (() => {
      const n = Number(value);
      if (!value || !Number.isFinite(n) || n <= 0) return '';
      const d = new Date(n * 1000);
      const pad = (x: number) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    })();
    return (
      <div className="flex items-center gap-2">
        <Input type="datetime-local" value={local}
          onChange={(e) => { const v = e.target.value; onChange(v ? String(Math.floor(new Date(v).getTime() / 1000)) : ''); }} />
        <Input value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))} placeholder="unix 秒" className="w-28 font-mono" aria-label="时间戳" />
      </div>
    );
  }

  // ── type-driven widgets ──
  if (param.values && param.values.length > 0) {
    return (
      // Always render the empty option so a controlled <select value=""> has a
      // matching option (otherwise the browser shows the first value while state
      // stays '' — a "looks selected but sends nothing" trap for required enums).
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{param.required ? '（请选择）' : '（默认）'}</option>
        {param.values.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
      </Select>
    );
  }
  if (param.type === 'bool' || param.type === 'boolean') {
    return (
      <div className="flex h-9 items-center">
        <ToggleSwitch value={value === 'true' || value === '1'} onChange={(v) => onChange(v ? 'true' : 'false')} ariaLabel={param.name} />
      </div>
    );
  }
  if (param.type === 'message') {
    return <MessageParamField value={value} onChange={onChange} uin={uin} groupContext={groupContext} />;
  }
  if (isNumericType(param.type)) {
    return <Input type="number" value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={param.desc || (param.default !== undefined ? `默认 ${JSON.stringify(param.default)}` : '')} />;
  }
  return <Input value={value} onChange={(e) => onChange(e.target.value)}
    placeholder={param.desc || (param.default !== undefined ? `默认 ${JSON.stringify(param.default)}` : '')} />;
}

// Message param: the visual builder (keeps its own Seg[] model and emits the
// serialized OneBot array as the string param value) with a raw-text escape
// hatch. The builder is one-way (builder → value); switching to 原文 edits the
// string directly — the tester's global JSON mode covers full raw editing.
function MessageParamField({ value, onChange, uin, groupContext }: { value: string; onChange: (v: string) => void; uin: string; groupContext: string }) {
  const [mode, setMode] = useState<'build' | 'raw'>('build');
  const [segs, setSegs] = useState<Seg[]>([]);

  const updateSegs = (next: Seg[]) => {
    setSegs(next);
    onChange(next.length ? JSON.stringify(toOneBot(next)) : '');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'build', label: '构建器' }, { value: 'raw', label: '原文' }]} />
      </div>
      {mode === 'build' ? (
        <MessageBuilder segments={segs} onChange={updateSegs} uin={uin} groupId={groupContext} />
      ) : (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder='文本，或 OneBot 段数组 JSON：[{"type":"text","data":{"text":"hi"}}]'
          className="min-h-20 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
      )}
    </div>
  );
}
