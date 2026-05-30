// One row in the per-kind list view. Shows just enough to identify the
// adapter at a glance (name + projected summary + token state + the two
// flags) plus the inline enable toggle. Real editing always goes through
// the dialog — there are no live-typed inputs here.

import { motion } from 'motion/react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AdapterCommon } from './defaults';
import type { AdapterStatus } from '@/types';

const LIVE_STYLE: Record<AdapterStatus['status'], string> = {
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  down: 'bg-destructive/10 text-destructive',
  disabled: 'bg-muted text-muted-foreground',
};
const LIVE_LABEL: Record<AdapterStatus['status'], string> = {
  ok: '正常',
  warn: '注意',
  down: '异常',
  disabled: '未启用',
};

interface NodeSummaryCardProps<T extends AdapterCommon> {
  item: T;
  summary: string;
  duplicateName: boolean;
  /** Live runtime status from the OneBot manager, matched by adapter name. */
  liveStatus?: AdapterStatus;
  onToggleEnabled: (next: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function NodeSummaryCard<T extends AdapterCommon>({
  item,
  summary,
  duplicateName,
  liveStatus,
  onToggleEnabled,
  onEdit,
  onDelete,
}: NodeSummaryCardProps<T>) {
  const enabled = item.enabled !== false;
  const blankName = !item.name?.trim();

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-card/40 p-3 transition-opacity sm:flex-row sm:items-center sm:gap-3',
        !enabled && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('font-medium', blankName && 'text-destructive')}>
            {item.name || '(未命名)'}
          </span>
          {duplicateName && (
            <Badge variant="destructive" className="font-normal">名称重复</Badge>
          )}
          {!enabled && (
            <Badge variant="secondary" className="font-normal">已停用</Badge>
          )}
          {liveStatus && (
            <span
              className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', LIVE_STYLE[liveStatus.status])}
              title={liveStatus.detail}
            >
              {LIVE_LABEL[liveStatus.status]} · {liveStatus.detail}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground tabular-nums">{summary}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-normal">
            {item.messageFormat === 'string' ? 'CQ 码' : '数组'}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {item.reportSelfMessage ? '上报自身' : '不上报自身'}
          </Badge>
          {item.accessToken ? (
            <Badge variant="outline" className="font-normal">
              已设 Token
            </Badge>
          ) : (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              无 Token
            </Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2 sm:justify-end">
        <ToggleSwitch
          value={enabled}
          onChange={onToggleEnabled}
          ariaLabel={`启用 ${item.name || '该节点'}`}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onEdit}
          aria-label="编辑"
          className="text-muted-foreground hover:text-foreground"
        >
          <Pencil className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          aria-label="删除"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </motion.div>
  );
}

interface ToggleSwitchProps {
  value: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}

function ToggleSwitch({ value, onChange, ariaLabel }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value ? 'true' : 'false'}
      aria-label={ariaLabel}
      onClick={() => onChange(!value)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors',
        value ? 'border-primary bg-primary' : 'border-input bg-muted',
      )}
    >
      <motion.span
        className="inline-block size-4 rounded-full bg-background shadow-sm"
        animate={{ x: value ? 22 : 4 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  );
}
