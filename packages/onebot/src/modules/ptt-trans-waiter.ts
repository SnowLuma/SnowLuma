interface Pending {
    resolve(text: string): void;
    reject(error: Error): void;
}

const pending = new Map<string, Pending>();

export function pttTransKey(selfUin: number, msgId: number | bigint): string {
    if (typeof msgId === 'number' && !Number.isSafeInteger(msgId)) {
        throw new RangeError('PTT message id must be a safe integer or bigint');
    }

    return selfUin + ':' + BigInt.asIntN(64, BigInt(msgId));
}

/** Register before triggering; only this request may settle its own response or timeout. */
export function requestPttTransText(
    key: string,
    timeoutMs: number,
    trigger: () => Promise<string>,
): Promise<string> {
    pending.get(key)?.reject(new Error('语音转文字请求被新的请求取代'));

    return new Promise<string>((resolve, reject) => {
        const settle = (finish: () => void) => {
            if (pending.get(key) !== waiter) {
                return;
            }

            clearTimeout(timer);
            pending.delete(key);
            finish();
        };

        const waiter: Pending = {
            resolve: (text) => settle(() => resolve(text)),
            reject: (error) => settle(() => reject(error)),
        };
        const timer = setTimeout(() => {
            waiter.reject(new Error('语音转文字超时（未收到结果推送）'));
        }, timeoutMs);
        timer.unref();
        pending.set(key, waiter);

        void Promise.resolve()
            .then(trigger)
            .then(
                (text) => {
                    if (text) {
                        waiter.resolve(text);
                    }
                },
                (error: unknown) =>
                    waiter.reject(error instanceof Error ? error : new Error(String(error))),
            );
    });
}

/** QQ push results identify the account and message, not an individual trigger request. */
export function deliverPttTransText(key: string, text: string): boolean {
    const waiter = pending.get(key);

    if (!waiter) {
        return false;
    }

    waiter.resolve(text);
    return true;
}
