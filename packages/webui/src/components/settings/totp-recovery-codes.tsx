import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function TotpRecoveryCodes({
  codes,
  onConfirm,
}: {
  codes: string[];
  onConfirm: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        每个恢复码只能用一次。请立刻抄写或保存到离线位置，关闭后将无法再查看。
      </p>
      <ol className="grid grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="rounded-md border bg-muted/40 px-3 py-2 text-center tracking-wide">
            {code}
          </li>
        ))}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={async () => {
          if (await copyText(codes.join('\n'))) setCopied(true);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? '已复制' : '复制全部'}
      </Button>
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
