// FileSource — the control behind a file/image/record/video param. The bot runs
// on the SERVER, so a browser-local path is meaningless to it; this offers three
// honest sources: a URL the bot fetches, a path that already exists on the
// server, or a browser upload that we stream to a server temp path (and then
// feed that path to the action). Upload progress flows through the app-level
// task registry so it survives tab switches.
import { useRef, useState } from 'react';
import { FileUp, Link2, Loader2, ServerCog, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/api';
import { useDebugTasks } from '@/contexts/DebugTaskContext';
import { cn } from '@/lib/utils';
import type { FieldRole } from '@/types';

type Mode = 'url' | 'server' | 'upload';

const ACCEPT: Partial<Record<FieldRole, string>> = {
  image: 'image/*',
  record: 'audio/*',
  video: 'video/*',
};

function Seg({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
        active ? 'bg-card text-foreground shadow-sm ring-1 ring-border/60' : 'text-muted-foreground hover:text-foreground')}
    >
      {icon}{label}
    </button>
  );
}

export function FileSource({ value, onChange, role, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  role?: FieldRole;
  placeholder?: string;
}) {
  const api = useApi();
  const { start, update, finish } = useDebugTasks();
  const [mode, setMode] = useState<Mode>('url');
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = role ? ACCEPT[role] : undefined;

  const doUpload = async (file: File) => {
    setUploadErr(null);
    setUploadName(file.name);
    setUploading(true);
    const ac = new AbortController();
    const taskId = start({ kind: 'upload', label: `上传 ${file.name}`, progress: 0, cancel: () => ac.abort() });
    try {
      const res = await api.debug.upload(file, {
        signal: ac.signal,
        onProgress: (f) => update(taskId, { progress: f }),
      });
      if (!res.path) throw new Error(res.message || '上传失败');
      onChange(res.path);
      finish(taskId, 'done', res.path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '上传失败';
      setUploadErr(msg);
      finish(taskId, ac.signal.aborted ? 'canceled' : 'failed', msg);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="inline-flex w-fit gap-0.5 rounded-xl bg-muted/70 p-0.5">
        <Seg active={mode === 'url'} onClick={() => setMode('url')} icon={<Link2 className="h-3.5 w-3.5" />} label="URL" />
        <Seg active={mode === 'server'} onClick={() => setMode('server')} icon={<ServerCog className="h-3.5 w-3.5" />} label="服务器路径" />
        <Seg active={mode === 'upload'} onClick={() => setMode('upload')} icon={<FileUp className="h-3.5 w-3.5" />} label="上传" />
      </div>

      {mode === 'url' && (
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'https://…'} />
      )}

      {mode === 'server' && (
        <div className="flex flex-col gap-1">
          <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="/path/on/server/file.jpg" />
          <span className="text-xs text-muted-foreground">这是 <strong>运行 bot 的服务器</strong> 上的路径,不是你本机的。</span>
        </div>
      )}

      {mode === 'upload' && (
        <div className="flex flex-col gap-1.5">
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUpload(f); e.target.value = ''; }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className={cn('flex items-center justify-center gap-2 rounded-xl border border-dashed border-border/70 px-3 py-3 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-60')}
          >
            {uploading ? <><Loader2 className="h-4 w-4 animate-spin" /> 上传中…</> : <><FileUp className="h-4 w-4" /> 选择文件上传到服务器</>}
          </button>
          {value && uploadName && !uploading && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-meta">
              <span className="truncate text-muted-foreground">已上传:{uploadName}</span>
              <code className="ml-auto max-w-[55%] truncate font-mono text-muted-foreground/80" title={value}>{value}</code>
              <button type="button" onClick={() => { onChange(''); setUploadName(null); }} className="shrink-0 text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
            </div>
          )}
          {uploadErr && <span className="text-xs text-destructive">{uploadErr}</span>}
        </div>
      )}
    </div>
  );
}
