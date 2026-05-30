import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, Compass, Home, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Tone = 'primary' | 'destructive';

function StatusShell({
  tone,
  icon,
  code,
  title,
  description,
  children,
}: {
  tone: Tone;
  icon: ReactNode;
  code?: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[60vh] w-full flex-col items-center justify-center px-4 text-center">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="flex w-full max-w-md flex-col items-center"
      >
        <div
          className={
            tone === 'destructive'
              ? 'flex size-14 items-center justify-center rounded-2xl bg-destructive/10 ring-1 ring-destructive/20'
              : 'flex size-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20'
          }
        >
          {icon}
        </div>
        {code && (
          <span className="mt-4 font-mono text-4xl font-bold tracking-tight tabular-nums text-muted-foreground/60">
            {code}
          </span>
        )}
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{children}</div>
      </motion.div>
    </div>
  );
}

/** Rendered by the router for any unmatched path. */
export function NotFoundPage() {
  return (
    <StatusShell
      tone="primary"
      icon={<Compass className="size-7 text-primary" strokeWidth={1.75} />}
      code="404"
      title="页面不存在"
      description="你访问的地址没有对应的页面，可能链接已失效或输入有误。"
    >
      <Button onClick={() => window.location.assign('/')}>
        <Home className="size-4" /> 返回首页
      </Button>
    </StatusShell>
  );
}

/** Rendered by the router when a route component throws while rendering. */
export function ErrorPage({ error, reset }: { error?: Error; reset?: () => void }) {
  const message = error?.message?.trim();
  return (
    <StatusShell
      tone="destructive"
      icon={<AlertTriangle className="size-7 text-destructive" strokeWidth={1.75} />}
      title="页面出错了"
      description="渲染该页面时发生了意外错误。可以重试，或返回首页继续操作。"
    >
      {reset && (
        <Button variant="outline" onClick={reset}>
          <RotateCw className="size-4" /> 重试
        </Button>
      )}
      <Button onClick={() => window.location.assign('/')}>
        <Home className="size-4" /> 返回首页
      </Button>
      {message && (
        <pre className="mt-3 max-h-32 w-full overflow-auto rounded-md border bg-muted/40 px-3 py-2 text-left text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {message}
        </pre>
      )}
    </StatusShell>
  );
}
