import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, ScrollText, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';
import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import type { AgreementDoc } from '@/lib/api/types';

interface ConsentPageProps {
  documents: AgreementDoc[];
  version: string;
  /** Persist acceptance. Resolves {success:false,message} to show inline. */
  onAccept: () => Promise<{ success: boolean; message?: string }>;
  /** Operator refuses — caller logs them out. */
  onDecline: () => void;
}

const TAB_FALLBACK_TITLE: Record<string, string> = {
  eula: '用户协议 / EULA',
  privacy: '隐私政策 / Privacy',
};

/**
 * Full-screen consent gate shown once at first login, before the forced
 * password change. The operator must accept the EULA + Privacy Notice before
 * the panel unlocks; acceptance is keyed to the agreement content version, so
 * it persists across app upgrades and re-prompts only when the text changes.
 */
export function ConsentPage({ documents, version, onAccept, onDecline }: ConsentPageProps) {
  const tabs = documents.length > 0 ? documents : [];
  const [activeId, setActiveId] = useState<string>(tabs[0]?.id ?? 'eula');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = tabs.find((d) => d.id === activeId) ?? tabs[0];

  const handleAccept = async () => {
    if (!agreed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onAccept();
      if (!result.success) {
        setError(result.message ?? '提交失败，请重试');
        setSubmitting(false);
      }
      // on success the parent unmounts this gate; no local state change needed.
    } catch {
      // Defense in depth: onAccept should never reject (client resolves errors),
      // but never leave the button stuck on "提交中…" if it somehow does.
      setError('网络错误，请重试');
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-8">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% 0%, color-mix(in oklab, var(--primary) 18%, transparent) 0%, transparent 70%)',
        }}
      />
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex w-full max-w-3xl flex-col"
      >
        <Card className="border-primary/15 shadow-xl">
          <CardContent className="flex max-h-[88vh] flex-col p-7 sm:p-9">
            <div className="flex items-start gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
                <ScrollText className="size-6 text-primary" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">请阅读并同意以下协议</h1>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  首次使用前，请阅读并同意《用户协议》与《隐私政策》。同意一次后无需重复确认；仅当协议内容更新时才会再次请求确认。
                  <br />
                  Please read and accept the agreements below before first use. You only consent once — you'll be asked again only if the text changes.
                </p>
              </div>
            </div>

            {/* tab switcher */}
            <div className="mt-5 flex gap-1 rounded-lg bg-muted/60 p-1">
              {tabs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => setActiveId(doc.id)}
                  className={cn(
                    'flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    doc.id === activeId
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {doc.title?.split('/')[0]?.trim() || TAB_FALLBACK_TITLE[doc.id] || doc.id}
                </button>
              ))}
            </div>

            {active && (active.declaredVersion || active.effectiveDate) && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {active.declaredVersion && `版本 / Version ${active.declaredVersion}`}
                {active.declaredVersion && active.effectiveDate && ' · '}
                {active.effectiveDate && `生效 / Effective ${active.effectiveDate}`}
              </p>
            )}

            {/* document body */}
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-background/60 p-4">
              {active ? (
                <Markdown content={active.text} />
              ) : (
                <p className="text-sm text-muted-foreground">未能加载协议文本，请刷新页面重试。</p>
              )}
            </div>

            {/* agree checkbox — full-width row so it reads as an obvious control */}
            <button
              type="button"
              onClick={() => setAgreed((v) => !v)}
              aria-pressed={agreed}
              className={cn(
                'mt-4 flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors',
                agreed
                  ? 'border-primary/60 bg-primary/5'
                  : 'border-border hover:border-primary/40 hover:bg-accent/40',
              )}
            >
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors',
                  agreed
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/50 bg-background',
                )}
              >
                {agreed && <Check className="size-3.5" strokeWidth={3} />}
              </span>
              <span className="leading-snug">
                <span className="text-sm font-medium text-foreground">
                  我已阅读并同意《用户协议》与《隐私政策》
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  I have read and agree to the User Agreement and the Privacy Notice.
                </span>
              </span>
            </button>

            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onDecline} disabled={submitting}>
                不同意并退出
              </Button>
              <Button type="button" onClick={handleAccept} disabled={!agreed || submitting}>
                <ShieldCheck className="size-4" />
                {submitting ? '提交中…' : '同意并继续'}
              </Button>
            </div>
          </CardContent>
        </Card>
        <p className="mt-3 text-center text-[10px] text-muted-foreground/70">agreements {version.slice(0, 8)}</p>
      </motion.div>
    </div>
  );
}
