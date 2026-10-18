import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';
import type { OneBotConfig, QQInfo } from '@/types';
import { useApi } from '@/lib/api';

/** Account-scoped editing, persistence, and unsaved-change confirmation. */
export interface UseOneBotInstanceConfig {
    selectedUin: string | null;
    /** Loaded config for the current UIN. Null while loading or before a selection. */
    config: OneBotConfig | null;
    loading: boolean;
    loadError: string | null;
    reload: () => void;
    setConfig: (next: OneBotConfig) => void;
    /** True if the in-memory config diverges from the last server-confirmed snapshot. */
    dirty: boolean;
    /** Dirty edits require confirmation before switching accounts. */
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

type ConfigState =
    | { status: 'idle'; uin: null }
    | { status: 'loading'; uin: string }
    | { status: 'error'; uin: string; error: string }
    | { status: 'ready'; uin: string; config: OneBotConfig; savedSnapshot: string };

type SaveFeedback = { text: string; tone: UseOneBotInstanceConfig['saveStatusTone'] };
const IDLE_FEEDBACK: SaveFeedback = { text: '', tone: 'idle' };
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
    const { onSelectedUinChange } = options;
    // Load the first account without waiting for selection to propagate upward.
    const selectedUin = options.selectedUin ?? accounts[0]?.uin ?? null;
    const [state, setState] = useState<ConfigState>({ status: 'idle', uin: null });
    const [reloadGeneration, setReloadGeneration] = useState(0);
    const [saveFeedback, setSaveFeedback] = useState<SaveFeedback>(IDLE_FEEDBACK);
    const [pendingSwitchUin, setPendingSwitchUin] = useState<string | null>(null);
    const clearTimerRef = useRef<number | null>(null);
    const editRevisionRef = useRef(0);
    const saveGenerationRef = useRef(0);
    const selectedUinRef = useRef(selectedUin);
    selectedUinRef.current = selectedUin;

    // Publish the derived first selection so the sidebar and later routes retain it.
    useEffect(() => {
        if (options.selectedUin === null && selectedUin) {
            onSelectedUinChange(selectedUin);
        }
    }, [options.selectedUin, selectedUin, onSelectedUinChange]);

    // Load on UIN change. The api client already runs normalizeOneBotConfig.
    useEffect(() => {
        editRevisionRef.current += 1;
        saveGenerationRef.current += 1;

        if (clearTimerRef.current != null) {
            window.clearTimeout(clearTimerRef.current);
            clearTimerRef.current = null;
        }

        setSaveFeedback(IDLE_FEEDBACK);
        setPendingSwitchUin(null);

        if (!selectedUin) {
            setState({ status: 'idle', uin: null });
            return;
        }

        setState({ status: 'loading', uin: selectedUin });
        let cancelled = false;

        (async () => {
            try {
                const loaded = await api.config.get(selectedUin);

                if (cancelled) {
                    return;
                }

                editRevisionRef.current += 1;
                setState({
                    status: 'ready',
                    uin: selectedUin,
                    config: loaded,
                    savedSnapshot: JSON.stringify(loaded),
                });
            } catch (e) {
                console.error('load-config', e);

                if (!cancelled) {
                    setState({
                        status: 'error',
                        uin: selectedUin,
                        error: e instanceof Error ? e.message : '加载账号配置失败',
                    });
                }
            }
        })();

        return () => {
            cancelled = true;
            saveGenerationRef.current += 1;
        };
    }, [selectedUin, api, reloadGeneration]);

    useEffect(
        () => () => {
            if (clearTimerRef.current != null) {
                window.clearTimeout(clearTimerRef.current);
            }
        },
        [],
    );

    const current = state.uin === selectedUin ? state : null;
    const currentConfig = current?.status === 'ready' ? current.config : null;
    const savedSnapshot = current?.status === 'ready' ? current.savedSnapshot : null;
    const loading = selectedUin !== null && (!current || current.status === 'loading');
    const loadError = current?.status === 'error' ? current.error : null;

    const dirty = useMemo(() => {
        if (currentConfig == null || savedSnapshot == null) {
            return false;
        }

        return JSON.stringify(currentConfig) !== savedSnapshot;
    }, [currentConfig, savedSnapshot]);

    const setConfig = useCallback(
        (next: OneBotConfig) => {
            editRevisionRef.current += 1;
            setState((previous) =>
                previous.status === 'ready' && previous.uin === selectedUin
                    ? { ...previous, config: next }
                    : previous,
            );
        },
        [selectedUin],
    );
    const reload = useCallback(() => setReloadGeneration((generation) => generation + 1), []);

    const requestSwitchUin = useCallback(
        (uin: string) => {
            if (uin === selectedUin) {
                return;
            }

            if (dirty) {
                setPendingSwitchUin(uin);
            } else {
                onSelectedUinChange(uin);
            }
        },
        [dirty, selectedUin, onSelectedUinChange],
    );

    const confirmSwitch = useCallback(() => {
        if (pendingSwitchUin == null) {
            return;
        }

        onSelectedUinChange(pendingSwitchUin);
        setPendingSwitchUin(null);
    }, [pendingSwitchUin, onSelectedUinChange]);

    const cancelSwitch = useCallback(() => setPendingSwitchUin(null), []);

    const scheduleStatusClear = useCallback((uin: string, generation: number) => {
        if (clearTimerRef.current != null) {
            window.clearTimeout(clearTimerRef.current);
        }

        clearTimerRef.current = window.setTimeout(() => {
            clearTimerRef.current = null;

            if (selectedUinRef.current !== uin || saveGenerationRef.current !== generation) {
                return;
            }

            setSaveFeedback(IDLE_FEEDBACK);
        }, CLEAR_SAVE_STATUS_MS);
    }, []);

    const save = useCallback(
        async (override?: OneBotConfig) => {
            const target = override ?? currentConfig;

            if (!selectedUin || !target) {
                return;
            }

            const uin = selectedUin;
            const editRevision = editRevisionRef.current;
            const generation = ++saveGenerationRef.current;
            setSaveFeedback({ text: '保存中…', tone: 'saving' });

            try {
                const result = await runAction(
                    {
                        title: '正在保存账号配置',
                        detail: `账号 ${uin}`,
                        successTitle: '账号配置已更新',
                        successDetail: (saved) =>
                            !saved.online
                                ? '配置已保存，将在账号下次连接时应用'
                                : saved.applied
                                  ? '配置已保存并完成热重载'
                                  : '配置已保存',
                        errorTitle: '账号配置更新失败',
                        resultError: (saved) => {
                            if (!saved.saved) {
                                return saved.message || '服务器未确认配置已保存';
                            }

                            if (saved.online && !saved.applied) {
                                return `配置已保存，但热重载失败${saved.errors[0]?.message ? `：${saved.errors[0].message}` : ''}`;
                            }

                            return null;
                        },
                    },
                    () => api.config.save(uin, target),
                );

                if (selectedUinRef.current !== uin || saveGenerationRef.current !== generation) {
                    return;
                }

                if (!result.saved) {
                    setSaveFeedback({
                        text: `保存失败：${result.message || '服务器未确认配置已保存'}`,
                        tone: 'error',
                    });
                    return;
                }

                const unchanged = editRevisionRef.current === editRevision;
                setState((previous) =>
                    previous.status === 'ready' && previous.uin === uin
                        ? {
                              ...previous,
                              config: unchanged ? result.config : previous.config,
                              savedSnapshot: JSON.stringify(result.config),
                          }
                        : previous,
                );

                if (!unchanged) {
                    setSaveFeedback({ text: '上一版本已保存，当前修改待保存', tone: 'warning' });
                    return;
                }

                if (!result.online) {
                    setSaveFeedback({ text: '已保存，下次连接时应用', tone: 'warning' });
                } else if (result.applied) {
                    setSaveFeedback({ text: '已保存并应用', tone: 'success' });
                } else {
                    const first = result.errors[0]?.message;
                    setSaveFeedback({
                        text: `已保存，但热重载失败${first ? `：${first}` : ''}`,
                        tone: 'warning',
                    });
                }
            } catch (e) {
                if (selectedUinRef.current !== uin || saveGenerationRef.current !== generation) {
                    return;
                }

                setSaveFeedback({
                    text: `保存失败：${e instanceof Error ? e.message : '未知错误'}`,
                    tone: 'error',
                });
            } finally {
                if (selectedUinRef.current === uin && saveGenerationRef.current === generation) {
                    scheduleStatusClear(uin, generation);
                }
            }
        },
        [api, selectedUin, currentConfig, scheduleStatusClear, runAction],
    );

    return {
        selectedUin,
        config: currentConfig,
        loading,
        loadError,
        reload,
        setConfig,
        dirty,
        requestSwitchUin,
        pendingSwitchUin,
        confirmSwitch,
        cancelSwitch,
        save,
        saveStatus: saveFeedback.text,
        saveStatusTone: saveFeedback.tone,
    };
}
