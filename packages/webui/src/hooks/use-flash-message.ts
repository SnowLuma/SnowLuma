import { useEffect, useRef, useState } from 'react';

export type FlashKind = 'ok' | 'err';
export interface FlashMessage {
  kind: FlashKind;
  text: string;
}

/**
 * Transient status-banner state for a settings panel.
 *
 * - `flash(kind, text)` shows a message that auto-clears after `durationMs`,
 *   cancelling any prior auto-clear timer first.
 * - `setMsg` sets/clears the message directly (a persistent one that stays
 *   until the next action — e.g. a load-failure banner).
 * - The pending timer is cleared on unmount.
 *
 * Replaces the per-panel hand-rolled `msg` state + `msgTimer` ref + `flash` +
 * unmount cleanup, which had drifted (one panel omitted the ref, the
 * prior-timer cancel, and the unmount cleanup entirely — leaking a timer that
 * could fire a stale `setMsg` after unmount).
 */
export function useFlashMessage(durationMs = 2400): {
  msg: FlashMessage | null;
  flash: (kind: FlashKind, text: string) => void;
  setMsg: (msg: FlashMessage | null) => void;
} {
  const [msg, setMsg] = useState<FlashMessage | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flash = (kind: FlashKind, text: string) => {
    setMsg({ kind, text });
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), durationMs);
  };
  return { msg, flash, setMsg };
}
