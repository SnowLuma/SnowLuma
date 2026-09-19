import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/utils';

export function TotpRecoveryCodes({
  codes,
  onConfirm,
}: {
  codes: string[];
  onConfirm: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        每个恢复码只能用一次。请立刻抄写或保存到离线位置，关闭后将无法再查看。
      </p>
      <ol className="grid grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>
            <input
              readOnly
              value={code}
              className="w-full rounded-md border bg-muted/40 px-3 py-2 text-center tracking-wide outline-none"
              onFocus={(e) => e.currentTarget.select()}
            />
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={async () => {
          const ok = await copyText(codes.join('\n'));
          setCopied(ok);
          setCopyError(!ok);
          if (ok) window.setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? '已复制' : '复制全部'}
      </Button>
      {copyError && (
        <p className="text-xs text-destructive">复制失败，请长按上面的码手动拷贝。</p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          className="mt-0.5"
        />
        我已把恢复码保存到安全的地方
      </label>
      <Button type="button" disabled={!saved} onClick={onConfirm}>
        完成
      </Button>
    </div>
  );
}
