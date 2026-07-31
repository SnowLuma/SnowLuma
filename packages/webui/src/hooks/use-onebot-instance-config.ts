import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';
import type { OneBotConfig, QQInfo } from '@/types';
import { useApi } from '@/lib/api';

/**
 * Per-UIN OneBotInstance configuration editor. Owns the full lifecycle:
 * selection, load, in-memory edit (with dirty tracking), save (with refetch),
 * and a "switch UIN while dirty" guard that surfaces a pending switch the
 * view can confirm or cancel.
 */
export interface UseOneBotInstanceConfig {
  selectedUin: string | null;
  /** Loaded config for the current UIN. Null while loading or before a selection. */
  config: OneBotConfig | null;
  setConfig: (next: OneBotConfig) => void;
  /** True if the in-memory config diverges from the last server-confirmed snapshot. */
  dirty: boolean;
  /**
   * Request a UIN switch. If currently dirty, the switch is parked as
   * `pendingSwitchUin` and must be confirmed or cancelled. Otherwise it
   * applies immediately.
   */
  requestSwitchUin: (uin: string) => void;
  /** Non-null while a switch is parked waiting for confirmation. */
  pendingSwitchUin: string | null;
  confirmSwitch: () => void;
  cancelSwitch: () => void;
  /**
   * Persist to the backend. Pass an explicit config to save it directly —
   * the node dialog / enable-toggle / delete persist their freshly-computed
   * config in the same tick, before React has flushed `setConfig`, so they
   * can't rely on the (still-stale) closed-over `config`.
   */
  save: (override?: OneBotConfig) => Promise<void>;
  saveStatus: string;
  saveStatusTone: 'idle' | 'saving' | 'success' | 'warning' | 'error';
}

const CLEAR_SAVE_STATUS_MS = 3000;

export interface UseOneBotInstanceConfigOptions {
  /** Externally-owned current UIN. The hook reads it but does not own it. */
  selectedUin: string | null;
  /** Called when the hook wants to mutate selection (auto-select / confirmed switch). */
  onSelectedUinChange: (uin: string | null) => void;
}

export function useOneBotInstanceConfig(
  accounts: QQInfo[],
  options: UseOneBotInstanceConfigOptions,
): UseOneBotInstanceConfig {
  const api = useApi();
  const { runAction } = useActionFeedback();
  const { selectedUin, onSelectedUinChange } = options;
  const [config, setConfigState] = useState<OneBotConfig | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [saveStatusTone, setSaveStatusTone] = useState<UseOneBotInstanceConfig['saveStatusTone']>('idle');
  const [pendingSwitchUin, setPendingSwitchUin] = useState<string | null>(null);
  const clearTimerRef = useRef<number | null>(null);
  const editRevisionRef = useRef(0);
  const saveGenerationRef = useRef(0);
  const selectedUinRef = useRef(selectedUin);
  selectedUinRef.current = selectedUin;

  // Auto-select first account when none is selected yet.
  useEffect(() => {
    if (!selectedUin && accounts.length > 0) onSelectedUinChange(accounts[0].uin);
  }, [accounts, selectedUin, onSelectedUinChange]);

  // Load on UIN change. The api client already runs normalizeOneBotConfig.
  useEffect(() => {
    editRevisionRef.current += 1;
    saveGenerationRef.current += 1;
    if (clearTimerRef.current != null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setSaveStatus('');
    setSaveStatusTone('idle');
    if (!selectedUin) {
      setConfigState(null);
      setSavedSnapshot(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const loaded = await api.config.get(selectedUin);
        if (cancelled) return;
        editRevisionRef.current += 1;
        setConfigState(loaded);
        setSavedSnapshot(JSON.stringify(loaded));
      } catch (e) {
        console.error('load-config', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedUin, api]);

  useEffect(
    () => () => {
      if (clearTimerRef.current != null) window.clearTimeout(clearTimerRef.current);
    },
    [],
  );

  const dirty = useMemo(() => {
    if (config == null || savedSnapshot == null) return false;
    return JSON.stringify(config) !== savedSnapshot;
  }, [config, savedSnapshot]);

  const setConfig = useCallback((next: OneBotConfig) => {
    editRevisionRef.current += 1;
    setConfigState(next);
  }, []);

  const requestSwitchUin = useCallback(
    (uin: string) => {
      if (uin === selectedUin) return;
      if (dirty) setPendingSwitchUin(uin);
      else onSelectedUinChange(uin);
    },
    [dirty, selectedUin, onSelectedUinChange],
  );

  const confirmSwitch = useCallback(() => {
    if (pendingSwitchUin == null) return;
    onSelectedUinChange(pendingSwitchUin);
    setPendingSwitchUin(null);
  }, [pendingSwitchUin, onSelectedUinChange]);

  const cancelSwitch = useCallback(() => setPendingSwitchUin(null), []);

  const scheduleStatusClear = useCallback((uin: string, generation: number) => {
    if (clearTimerRef.current != null) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => {
      clearTimerRef.current = null;
      if (selectedUinRef.current !== uin || saveGenerationRef.current !== generation) return;
      setSaveStatus('');
      setSaveStatusTone('idle');
    }, CLEAR_SAVE_STATUS_MS);
  }, []);

  const save = useCallback(async (override?: OneBotConfig) => {
    const target = override ?? config;
    if (!selectedUin || !target) return;
    const uin = selectedUin;
    const editRevision = editRevisionRef.current;
    const generation = ++saveGenerationRef.current;
    setSaveStatus('保存中...');
    setSaveStatusTone('saving');
    try {
      const result = await runAction(
        {
          title: '正在保存账号配置',
          detail: `账号 ${uin}`,
          successTitle: '账号配置已更新',
          successDetail: (saved) => (
            !saved.online
              ? '配置已保存，将在账号下次连接时应用'
              : saved.applied
                ? '配置已保存并完成热重载'
                : '配置已保存'
          ),
          errorTitle: '账号配置更新失败',
          resultError: (saved) => {
            if (!saved.saved) return saved.message || '服务器未确认配置已保存';
            if (saved.online && !saved.applied) {
              return `配置已保存，但热重载失败${saved.errors[0]?.message ? `：${saved.errors[0].message}` : ''}`;
            }
            return null;
          },
        },
        () => api.config.save(uin, target),
      );
      if (selectedUinRef.current !== uin || saveGenerationRef.current !== generation) return;
      if (!result.saved) {
        setSaveStatus(`保存失败：${result.message || '服务器未确认配置已保存'}`);
        setSaveStatusTone('error');
        return;
      }
      setSavedSnapshot(JSON.stringify(result.config));
      if (editRevisionRef.current === editRevision) {
        setConfigState(result.config);
      } else {
        setSaveStatus('上一版本已保存，当前修改仍待保存');
        setSaveStatusTone('warning');
        return;
      }
      if (!result.online) {
        setSaveStatus('保存成功；当前离线，将在下次连接时应用');
        setSaveStatusTone('warning');
      } else if (result.applied) {
        setSaveStatus('保存成功，热重载完成');
        setSaveStatusTone('success');
      } else {
        const first = result.errors[0]?.message;
        setSaveStatus(`保存成功，但热重载失败${first ? `：${first}` : ''}`);
        setSaveStatusTone('warning');
      }
    } catch (e) {
      if (selectedUinRef.current !== uin || saveGenerationRef.current !== generation) return;
      setSaveStatus(`保存失败：${e instanceof Error ? e.message : '未知错误'}`);
      setSaveStatusTone('error');
    } finally {
      if (selectedUinRef.current === uin && saveGenerationRef.current === generation) {
        scheduleStatusClear(uin, generation);
      }
    }
  }, [api, selectedUin, config, scheduleStatusClear, runAction]);

  return {
    selectedUin,
    config,
    setConfig,
    dirty,
    requestSwitchUin,
    pendingSwitchUin,
    confirmSwitch,
    cancelSwitch,
    save,
    saveStatus,
    saveStatusTone,
  };
}
