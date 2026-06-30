// Debug — a multi-tab developer console over /api/debug/*. Tabs: the action
// tester, the visual message composer, the live activity feed, and an embedded
// API browser. The browser's 试一下 prefills the tester and switches to it.
// Apple-HIG flavour throughout (sliding-indicator tabs, translucent chrome).
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { BookOpen, Bug, FlaskConical, MessageSquarePlus, RadioTower } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tabs } from '@/components/ui/tabs';
import { ActionTester } from '@/components/debug/action-tester';
import { MessageComposer } from '@/components/debug/message-composer';
import { LiveActivity } from '@/components/debug/live-activity';
import { ApiBrowser } from '@/components/debug/api-browser';
import { useApi } from '@/lib/api';
import type { DebugActionDoc, QQInfo } from '@/types';

type Tab = 'tester' | 'compose' | 'activity' | 'api';

export function DebugPage() {
  const api = useApi();
  const [accounts, setAccounts] = useState<QQInfo[]>([]);
  const [docs, setDocs] = useState<DebugActionDoc[]>([]);
  const [tab, setTab] = useState<Tab>('tester');
  const [preset, setPreset] = useState<{ name: string; nonce: number } | undefined>();

  useEffect(() => {
    void (async () => {
      try {
        const [qq, acts] = await Promise.all([api.qqList(), api.debug.actions()]);
        setAccounts(qq);
        setDocs(acts.actions);
      } catch { /* surfaced lazily on invoke */ }
    })();
  }, [api]);

  const tryAction = (name: string) => {
    setPreset((p) => ({ name, nonce: (p?.nonce ?? 0) + 1 }));
    setTab('tester');
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <motion.header
        initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        className="sticky top-0 z-20 -mx-1 flex flex-col gap-3 rounded-b-2xl bg-background/60 px-1 py-3 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Bug className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">调试</h1>
            <p className="text-sm text-muted-foreground">接口测试 · 消息构建 · 实时观测 · API 参考</p>
          </div>
        </div>
        <Tabs
          aria-label="调试工具"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'tester', label: '测试台', icon: <FlaskConical className="h-4 w-4" /> },
            { value: 'compose', label: '消息构建', icon: <MessageSquarePlus className="h-4 w-4" /> },
            { value: 'activity', label: '实时活动', icon: <RadioTower className="h-4 w-4" /> },
            { value: 'api', label: 'API 浏览器', icon: <BookOpen className="h-4 w-4" />, badge: docs.length || undefined },
          ]}
        />
      </motion.header>

      {/* Tester / compose / activity stay MOUNTED and toggle via CSS so the
          live feed's SSE never drops (it must capture events fired from other
          tabs) and in-progress params/messages survive a peek at another tab.
          ApiBrowser has no state worth preserving and is heavy (~520 rows), so
          it mounts on demand. */}
      <div className={cn(tab !== 'tester' && 'hidden')}><ActionTester accounts={accounts} docs={docs} presetAction={preset} /></div>
      <div className={cn(tab !== 'compose' && 'hidden')}><MessageComposer accounts={accounts} /></div>
      <div className={cn(tab !== 'activity' && 'hidden')}><LiveActivity /></div>
      {tab === 'api' && <ApiBrowser docs={docs} onTry={tryAction} />}
    </div>
  );
}
