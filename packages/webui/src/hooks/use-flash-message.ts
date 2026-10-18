import { useCallback, useEffect, useRef, useState } from 'react';

export type FlashKind = 'ok' | 'err';
export interface FlashMessage {
    kind: FlashKind;
    text: string;
}

/** `flash` expires automatically; `setMsg` replaces it with a persistent message. */
export function useFlashMessage(durationMs = 2400): {
    msg: FlashMessage | null;
    flash: (kind: FlashKind, text: string) => void;
    setMsg: (msg: FlashMessage | null) => void;
} {
    const [msg, setMessage] = useState<FlashMessage | null>(null);
    const timer = useRef<number | null>(null);
    const cancelTimer = useCallback(() => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
        }

        timer.current = null;
    }, []);
    useEffect(() => cancelTimer, [cancelTimer]);
    const setMsg = useCallback(
        (next: FlashMessage | null) => {
            cancelTimer();
            setMessage(next);
        },
        [cancelTimer],
    );
    const flash = useCallback(
        (kind: FlashKind, text: string) => {
            setMsg({ kind, text });
            timer.current = window.setTimeout(() => {
                timer.current = null;
                setMessage(null);
            }, durationMs);
        },
        [durationMs, setMsg],
    );
    return { msg, flash, setMsg };
}
