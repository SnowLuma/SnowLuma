// FaceGrid — pick a QQ classic face id. Renders the classic face sprites from
// QQ's long-standing public CDN; any id whose image 404s hides itself, so a
// curated-but-imperfect id list still looks clean. A manual id box is the
// escape hatch for faces outside the classic range.
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// Classic QQ face ids that resolve on the gtimg CDN. Curated to avoid the gaps
// in the 0..170 range (deprecated / never-existed ids) that would 404.
const CLASSIC_FACE_IDS: number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42,
  43, 46, 49, 53, 60, 63, 64, 66, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84,
  85, 86, 87, 88, 89, 96, 97, 98, 99, 100, 101, 102, 103, 104, 106, 109, 111,
  116, 118, 120, 122, 123, 124, 125, 129, 144, 147, 171, 173, 174, 175, 176,
  179, 180, 181, 182, 183, 201, 203, 212, 214, 219, 222, 227,
];

const faceUrl = (id: number) => `https://qzonestyle.gtimg.cn/qzone/em/e${id}.png`;

export function FaceGrid({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [q, setQ] = useState('');
  const [broken, setBroken] = useState<Set<number>>(() => new Set());

  const ids = useMemo(() => {
    const qq = q.trim();
    const base = CLASSIC_FACE_IDS.filter((id) => !broken.has(id));
    if (!qq) return base;
    return base.filter((id) => String(id).includes(qq));
  }, [q, broken]);

  const selected = value.trim();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按 id 过滤…" className="h-8 flex-1" />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ''))}
          placeholder="id"
          inputMode="numeric"
          className="h-8 w-20 text-center font-mono"
          aria-label="表情 id"
        />
      </div>
      <div className="grid max-h-48 grid-cols-8 gap-1 overflow-auto rounded-xl border border-border/60 bg-muted/30 p-2 sm:grid-cols-10">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            title={`face ${id}`}
            onClick={() => onChange(String(id))}
            className={cn('flex aspect-square items-center justify-center rounded-lg p-1 transition-colors hover:bg-accent',
              selected === String(id) && 'bg-primary/15 ring-1 ring-primary/50')}
          >
            <img
              src={faceUrl(id)}
              alt={`face ${id}`}
              className="h-full w-full object-contain"
              loading="lazy"
              onError={() => setBroken((prev) => { const n = new Set(prev); n.add(id); return n; })}
            />
          </button>
        ))}
        {ids.length === 0 && <span className="col-span-full py-4 text-center text-xs text-muted-foreground">无匹配表情</span>}
      </div>
    </div>
  );
}
