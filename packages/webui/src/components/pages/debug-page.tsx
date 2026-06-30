// Debug — a standalone top-level page. The action tester and live activity are
// extracted into their own components (ActionTester / LiveActivity); the
// multi-tab console shell lands in a later phase. Apple-HIG flavour throughout.
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Bug } from 'lucide-react';
import { ActionTester } from '@/components/debug/action-tester';
import { LiveActivity } from '@/components/debug/live-activity';
import { useApi } from '@/lib/api';
import type { DebugActionDoc, QQInfo } from '@/types';

export function DebugPage() {
  const api = useApi();
  const [accounts, setAccounts] = useState<QQInfo[]>([]);
  const [docs, setDocs] = useState<DebugActionDoc[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const [qq, acts] = await Promise.all([api.qqList(), api.debug.actions()]);
        setAccounts(qq);
        setDocs(acts.actions);
      } catch { /* surfaced lazily on invoke */ }
    })();
  }, [api]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <motion.header
        initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        className="sticky top-0 z-10 -mx-1 flex items-center justify-between gap-4 rounded-b-2xl bg-background/60 px-1 py-3 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Bug className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">调试</h1>
            <p className="text-sm text-muted-foreground">接口测试台与实时活动观测</p>
          </div>
        </div>
      </motion.header>

      <ActionTester accounts={accounts} docs={docs} />
      <LiveActivity />
    </div>
  );
}
