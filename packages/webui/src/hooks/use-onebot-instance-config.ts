import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const { selectedUin, onSelectedUinChange } = options;
  const [config, setConfigState] = useState<OneBotConfig | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState('');
  const [pendingSwitchUin, setPendingSwitchUin] = useState<string | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  // Auto-select first account when none is selected yet.
  useEffect(() => {
    if (!selectedUin && accounts.length > 0) onSelectedUinChange(accounts[0].uin);
  }, [accounts, selectedUin, onSelectedUinChange]);

  // Load on UIN change. The api client already runs normalizeOneBotConfig.
  useEffect(() => {
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

  const setConfig = useCallback((next: OneBotConfig) => setConfigState(next), []);

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

  const scheduleStatusClear = useCallback(() => {
    if (clearTimerRef.current != null) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => {
      setSaveStatus('');
      clearTimerRef.current = null;
    }, CLEAR_SAVE_STATUS_MS);
  }, []);

  const save = useCallback(async (override?: OneBotConfig) => {
    const target = override ?? config;
    if (!selectedUin || !target) return;
    setSaveStatus('保存中...');
    try {
      const serverView = await api.config.save(selectedUin, target);
      setConfigState(serverView);
      setSavedSnapshot(JSON.stringify(serverView));
      setSaveStatus('保存成功');
    } catch (e) {
      setSaveStatus(`保存失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      scheduleStatusClear();
    }
  }, [api, selectedUin, config, scheduleStatusClear]);

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
  };
}
