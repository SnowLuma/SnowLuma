// MessageBuilder — a visual OneBot message composer so you never hand-write a
// segment array. Common segments are first-class (text / @ / image / face /
// reply / record / video); advanced ones fold away (file / mface / poke / json
// / xml / markdown / forward-node). `node` nests a full builder (merged
// forward). Rows reorder by drag. Emits the live OneBot segment array up.
import { useState } from 'react';
import {
  AtSign, ChevronDown, Code2, FileText, Film, Forward, GripVertical, Hand, Image as ImageIcon,
  Mic, Plus, Quote, Smile, Sticker, Trash2, Type,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Picker } from '@/components/ui/picker';
import { FaceGrid } from '@/components/ui/face-grid';
import { FileSource } from '@/components/debug/file-source';
import { useGroupMembers } from '@/hooks/use-debug-contacts';
import { cn } from '@/lib/utils';

// ── segment model ──
// `_id` is a stable React key tied to a segment's identity (so editing one field
// doesn't remount the row and lose focus / inner control state); it is NOT
// serialised. SegBody is the discriminated union; Seg adds the id.
type SegBody =
  | { k: 'text'; text: string }
  | { k: 'at'; qq: string }
  | { k: 'image'; file: string }
  | { k: 'face'; id: string }
  | { k: 'reply'; id: string }
  | { k: 'record'; file: string }
  | { k: 'video'; file: string }
  | { k: 'file'; file: string; name: string }
  | { k: 'mface'; emoji_id: string; emoji_package_id: string; key: string; summary: string }
  | { k: 'poke'; type: string }
  | { k: 'json'; data: string }
  | { k: 'xml'; data: string }
  | { k: 'markdown'; content: string }
  | { k: 'node'; user_id: string; nickname: string; content: Seg[] };
export type Seg = SegBody & { _id: string };

let segSeq = 0;
const nid = () => `s${segSeq++}`;

const BLANK: Record<SegBody['k'], () => SegBody> = {
  text: () => ({ k: 'text', text: '' }),
  at: () => ({ k: 'at', qq: '' }),
  image: () => ({ k: 'image', file: '' }),
  face: () => ({ k: 'face', id: '' }),
  reply: () => ({ k: 'reply', id: '' }),
  record: () => ({ k: 'record', file: '' }),
  video: () => ({ k: 'video', file: '' }),
  file: () => ({ k: 'file', file: '', name: '' }),
  mface: () => ({ k: 'mface', emoji_id: '', emoji_package_id: '', key: '', summary: '' }),
  poke: () => ({ k: 'poke', type: '1' }),
  json: () => ({ k: 'json', data: '' }),
  xml: () => ({ k: 'xml', data: '' }),
  markdown: () => ({ k: 'markdown', content: '' }),
  node: () => ({ k: 'node', user_id: '', nickname: '', content: [] }),
};

/** A fresh segment with a stable id. */
export function newSeg(k: SegBody['k']): Seg {
  return { ...BLANK[k](), _id: nid() } as Seg;
}

/** Serialise the builder model to a OneBot v11 segment array (drops `_id`). */
export function toOneBot(segs: Seg[]): Array<{ type: string; data: Record<string, unknown> }> {
  return segs.map((s): { type: string; data: Record<string, unknown> } => {
    switch (s.k) {
      case 'text': return { type: 'text', data: { text: s.text } };
      case 'at': return { type: 'at', data: { qq: s.qq } };
      case 'image': return { type: 'image', data: { file: s.file } };
      case 'face': return { type: 'face', data: { id: Number(s.id) || 0 } };
      case 'reply': return { type: 'reply', data: { id: Number(s.id) || 0 } };
      case 'record': return { type: 'record', data: { file: s.file } };
      case 'video': return { type: 'video', data: { file: s.file } };
      case 'file': return { type: 'file', data: { file: s.file, name: s.name } };
      case 'mface': return { type: 'mface', data: { emoji_id: s.emoji_id, emoji_package_id: s.emoji_package_id, key: s.key, summary: s.summary } };
      case 'poke': return { type: 'poke', data: { type: Number(s.type) || 1 } };
      case 'json': return { type: 'json', data: { data: s.data } };
      case 'xml': return { type: 'xml', data: { data: s.data } };
      case 'markdown': return { type: 'markdown', data: { content: s.content } };
      case 'node': return { type: 'node', data: { user_id: Number(s.user_id) || 0, nickname: s.nickname, content: toOneBot(s.content) } };
    }
  });
}

const COMMON: { k: SegBody['k']; label: string; icon: React.ReactNode }[] = [
  { k: 'text', label: '文本', icon: <Type className="h-4 w-4" /> },
  { k: 'at', label: '@', icon: <AtSign className="h-4 w-4" /> },
  { k: 'image', label: '图片', icon: <ImageIcon className="h-4 w-4" /> },
  { k: 'face', label: '表情', icon: <Smile className="h-4 w-4" /> },
  { k: 'reply', label: '回复', icon: <Quote className="h-4 w-4" /> },
  { k: 'record', label: '语音', icon: <Mic className="h-4 w-4" /> },
  { k: 'video', label: '视频', icon: <Film className="h-4 w-4" /> },
];
const ADVANCED: { k: SegBody['k']; label: string; icon: React.ReactNode }[] = [
  { k: 'file', label: '文件', icon: <FileText className="h-4 w-4" /> },
  { k: 'mface', label: '商城表情', icon: <Sticker className="h-4 w-4" /> },
  { k: 'poke', label: '戳一戳', icon: <Hand className="h-4 w-4" /> },
  { k: 'json', label: 'JSON 卡片', icon: <Code2 className="h-4 w-4" /> },
  { k: 'xml', label: 'XML 卡片', icon: <Code2 className="h-4 w-4" /> },
  { k: 'markdown', label: 'Markdown', icon: <Code2 className="h-4 w-4" /> },
  { k: 'node', label: '合并转发节点', icon: <Forward className="h-4 w-4" /> },
];

const LABELS: Record<SegBody['k'], string> = {
  text: '文本', at: '@', image: '图片', face: '表情', reply: '回复', record: '语音', video: '视频',
  file: '文件', mface: '商城表情', poke: '戳一戳', json: 'JSON', xml: 'XML', markdown: 'Markdown', node: '转发节点',
};

export function MessageBuilder({ segments, onChange, uin, groupId, depth = 0 }: {
  segments: Seg[];
  onChange: (segs: Seg[]) => void;
  uin: string;
  /** group context for @ member picking (empty for private targets). */
  groupId: string;
  depth?: number;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  const add = (k: SegBody['k']) => { onChange([...segments, newSeg(k)]); setShowAdd(false); };
  const patch = (i: number, next: Seg) => onChange(segments.map((s, j) => (j === i ? next : s)));
  const remove = (i: number) => onChange(segments.filter((_, j) => j !== i));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= segments.length || from === to) return;
    const next = segments.slice();
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    onChange(next);
  };

  return (
    <div className={cn('flex flex-col gap-2', depth > 0 && 'rounded-xl border border-border/50 bg-muted/20 p-2')}>
      {segments.length === 0 && (
        <p className="py-2 text-center text-[12px] text-muted-foreground">空消息 — 在下方添加段</p>
      )}

      {segments.map((s, i) => (
        <div
          key={s._id}
          draggable
          // stopPropagation makes the nested-builder boundary explicit: a child
          // row's drag never reaches the parent node row.
          onDragStart={(e) => { e.stopPropagation(); setDragFrom(i); }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.stopPropagation(); if (dragFrom !== null) move(dragFrom, i); setDragFrom(null); }}
          onDragEnd={() => setDragFrom(null)}
          className="flex items-start gap-2 rounded-xl border border-border/50 bg-card/60 p-2"
        >
          <GripVertical className="mt-1 h-4 w-4 shrink-0 cursor-grab text-muted-foreground/50" />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-muted-foreground">{LABELS[s.k]}</span>
              <div className="flex items-center gap-0.5">
                <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} className="rounded px-1 text-muted-foreground hover:bg-muted disabled:opacity-30" title="上移">↑</button>
                <button type="button" onClick={() => move(i, i + 1)} disabled={i === segments.length - 1} className="rounded px-1 text-muted-foreground hover:bg-muted disabled:opacity-30" title="下移">↓</button>
                <button type="button" onClick={() => remove(i)} className="rounded p-0.5 text-muted-foreground hover:text-destructive" title="删除"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            <SegmentEditor seg={s} onChange={(n) => patch(i, n)} uin={uin} groupId={groupId} depth={depth} />
          </div>
        </div>
      ))}

      <div className="relative">
        <button type="button" onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border/70 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground">
          <Plus className="h-3.5 w-3.5" /> 添加段
        </button>
        {showAdd && (
          <div className="absolute z-30 mt-1.5 w-64 rounded-xl border border-border/60 bg-popover p-2 shadow-lg">
            <div className="grid grid-cols-4 gap-1">
              {COMMON.map((c) => (
                <button key={c.k} type="button" onClick={() => add(c.k)}
                  className="flex flex-col items-center gap-1 rounded-lg p-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
                  {c.icon}{c.label}
                </button>
              ))}
            </div>
            <details className="mt-1.5">
              <summary className="cursor-pointer list-none px-1 text-[11px] text-muted-foreground hover:text-foreground"><span className="inline-flex items-center gap-1"><ChevronDown className="h-3 w-3" /> 进阶段</span></summary>
              <div className="mt-1 grid grid-cols-4 gap-1">
                {ADVANCED.map((c) => (
                  <button key={c.k} type="button" onClick={() => add(c.k)}
                    className="flex flex-col items-center gap-1 rounded-lg p-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
                    {c.icon}{c.label}
                  </button>
                ))}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

function AtEditor({ seg, onChange, uin, groupId }: { seg: Extract<Seg, { k: 'at' }>; onChange: (s: Seg) => void; uin: string; groupId: string }) {
  const { items, loading, error, refresh } = useGroupMembers(uin, groupId);
  const options = [{ value: 'all', label: '@全体成员', sub: 'all' }, ...items];
  return (
    <Picker ariaLabel="@某人" value={seg.qq} onChange={(v) => onChange({ ...seg, qq: v })}
      options={options} loading={loading} error={error} onRefresh={refresh}
      placeholder={groupId ? '选择成员 / @全体' : '输入 QQ 号(私聊无成员)'} validateRaw={(s) => s === 'all' || /^\d{3,}$/.test(s)} />
  );
}

function SegmentEditor({ seg, onChange, uin, groupId, depth }: { seg: Seg; onChange: (s: Seg) => void; uin: string; groupId: string; depth: number }) {
  switch (seg.k) {
    case 'text':
      return <textarea value={seg.text} onChange={(e) => onChange({ ...seg, text: e.target.value })} placeholder="文本内容"
        className="min-h-16 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40" />;
    case 'at':
      return <AtEditor seg={seg} onChange={onChange} uin={uin} groupId={groupId} />;
    case 'image': return <FileSource role="image" value={seg.file} onChange={(v) => onChange({ ...seg, file: v })} />;
    case 'record': return <FileSource role="record" value={seg.file} onChange={(v) => onChange({ ...seg, file: v })} />;
    case 'video': return <FileSource role="video" value={seg.file} onChange={(v) => onChange({ ...seg, file: v })} />;
    case 'file':
      return (
        <div className="flex flex-col gap-1.5">
          <FileSource role="file" value={seg.file} onChange={(v) => onChange({ ...seg, file: v })} />
          <Input value={seg.name} onChange={(e) => onChange({ ...seg, name: e.target.value })} placeholder="文件名(可选)" />
        </div>
      );
    case 'face': return <FaceGrid value={seg.id} onChange={(v) => onChange({ ...seg, id: v })} />;
    case 'reply': return <Input value={seg.id} onChange={(e) => onChange({ ...seg, id: e.target.value.replace(/[^\d-]/g, '') })} placeholder="回复的消息 id" className="font-mono" />;
    case 'poke': return <Input value={seg.type} onChange={(e) => onChange({ ...seg, type: e.target.value.replace(/[^\d]/g, '') })} placeholder="戳一戳类型(默认 1)" className="font-mono" />;
    case 'json': return <textarea value={seg.data} onChange={(e) => onChange({ ...seg, data: e.target.value })} placeholder='JSON 卡片原文 {"app":…}' className="min-h-16 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring" />;
    case 'xml': return <textarea value={seg.data} onChange={(e) => onChange({ ...seg, data: e.target.value })} placeholder="XML 卡片原文 <msg>…" className="min-h-16 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring" />;
    case 'markdown': return <textarea value={seg.content} onChange={(e) => onChange({ ...seg, content: e.target.value })} placeholder="Markdown 内容" className="min-h-16 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring" />;
    case 'mface':
      return (
        <div className="grid grid-cols-2 gap-1.5">
          <Input value={seg.emoji_id} onChange={(e) => onChange({ ...seg, emoji_id: e.target.value })} placeholder="emoji_id" className="font-mono text-xs" />
          <Input value={seg.emoji_package_id} onChange={(e) => onChange({ ...seg, emoji_package_id: e.target.value })} placeholder="emoji_package_id" className="font-mono text-xs" />
          <Input value={seg.key} onChange={(e) => onChange({ ...seg, key: e.target.value })} placeholder="key" className="font-mono text-xs" />
          <Input value={seg.summary} onChange={(e) => onChange({ ...seg, summary: e.target.value })} placeholder="summary(可选)" className="text-xs" />
        </div>
      );
    case 'node':
      return (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-1.5">
            <Input value={seg.user_id} onChange={(e) => onChange({ ...seg, user_id: e.target.value.replace(/[^\d]/g, '') })} placeholder="发送者 QQ" className="font-mono text-xs" />
            <Input value={seg.nickname} onChange={(e) => onChange({ ...seg, nickname: e.target.value })} placeholder="发送者昵称" className="text-xs" />
          </div>
          <div>
            <span className="mb-1 block text-[11px] text-muted-foreground">节点内容(可再嵌套)</span>
            {depth < 3 ? (
              <MessageBuilder segments={seg.content} onChange={(c) => onChange({ ...seg, content: c })} uin={uin} groupId={groupId} depth={depth + 1} />
            ) : (
              <p className="text-[11px] text-destructive">嵌套层级过深</p>
            )}
          </div>
        </div>
      );
  }
}

/** A compact human-readable preview line of a built message. */
export function previewSegments(segs: Seg[]): string {
  return segs.map((s) => {
    switch (s.k) {
      case 'text': return s.text;
      case 'at': return s.qq === 'all' ? '@全体' : `@${s.qq}`;
      case 'image': return '[图片]';
      case 'face': return `[表情${s.id}]`;
      case 'reply': return '[回复]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'file': return `[文件${s.name ? ':' + s.name : ''}]`;
      case 'mface': return '[商城表情]';
      case 'poke': return '[戳一戳]';
      case 'json': return '[JSON卡片]';
      case 'xml': return '[XML卡片]';
      case 'markdown': return '[Markdown]';
      case 'node': return `[转发:${s.nickname || s.user_id}]`;
    }
  }).join('');
}

/** True if the message contains forward nodes (→ send via the forward action). */
export function hasNodes(segs: Seg[]): boolean {
  return segs.some((s) => s.k === 'node');
}

/** Per-segment completeness check (recurses into node content). Returns the
 *  first problem string, or null. The forward "all nodes" rule is enforced
 *  separately at the top level (only the forward action's `messages` array must
 *  be all-nodes; a node's own content is a normal message). */
export function validateSegs(segs: Seg[]): string | null {
  for (const s of segs) {
    switch (s.k) {
      case 'at': if (!s.qq.trim()) return '@ 段未选择对象'; break;
      case 'image': if (!s.file.trim()) return '图片段未指定来源'; break;
      case 'record': if (!s.file.trim()) return '语音段未指定来源'; break;
      case 'video': if (!s.file.trim()) return '视频段未指定来源'; break;
      case 'file': if (!s.file.trim()) return '文件段未指定来源'; break;
      case 'reply': if (!s.id.trim()) return '回复段缺少消息 id'; break;
      case 'node': {
        if (!s.user_id.trim()) return '转发节点缺少发送者 QQ';
        if (s.content.length === 0) return '转发节点内容为空';
        const inner = validateSegs(s.content);
        if (inner) return inner;
        break;
      }
      default: break;
    }
  }
  return null;
}
