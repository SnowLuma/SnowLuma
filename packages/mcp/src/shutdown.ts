export interface ShutdownOptions {
    closeFeatures(): Promise<void>;
    closeProtocol(): Promise<void>;
    forceClose(): Promise<void>;
    graceMs?: number;
    onTimeout?: () => void;
    onLateProtocolError?: (error: unknown) => void;
}

/** Persist task shutdown before waiting on a peer that may have stopped reading stdout. */
export async function shutdownRuntime(options: ShutdownOptions): Promise<void> {
    const failures: unknown[] = [];

    try {
        await options.closeFeatures();
    } catch (error) {
        failures.push(error);
    }

    const protocol = Promise.resolve()
        .then(() => options.closeProtocol())
        .then(
            () => ({ kind: 'closed' as const }),
            (error: unknown) => ({ kind: 'failed' as const, error }),
        );
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), options.graceMs ?? 1000);
    });
    const outcome = await Promise.race([protocol, timeout]);
    clearTimeout(timer);

    if (outcome.kind === 'failed') {
        failures.push(outcome.error);
    }

    if (outcome.kind === 'timeout') {
        // A protocol rejection can arrive after the bounded shutdown returns.
        // Observe the settled outcome too, including races with the deadline.
        void protocol.then((late) => {
            if (late.kind !== 'failed') {
                return;
            }

            try {
                if (options.onLateProtocolError) {
                    options.onLateProtocolError(late.error);
                } else {
                    console.error(
                        '[snowluma-mcp] protocol shutdown failed after timeout: %s',
                        late.error instanceof Error ? late.error.name : 'unknown',
                    );
                }
            } catch (reportError) {
                console.error(
                    '[snowluma-mcp] late shutdown error reporting failed: %s; original: %s',
                    reportError instanceof Error ? reportError.name : 'unknown',
                    late.error instanceof Error ? late.error.name : 'unknown',
                );
            }
        });

        try {
            if (options.onTimeout) {
                options.onTimeout();
            } else {
                console.error('[snowluma-mcp] protocol shutdown timed out; closing transport');
            }
        } catch (error) {
            failures.push(error);
        }
    }

    if (outcome.kind !== 'closed') {
        try {
            await options.forceClose();
        } catch (error) {
            failures.push(error);
        }
    }

    if (failures.length === 1) {
        throw failures[0];
    }

    if (failures.length > 1) {
        throw new AggregateError(failures, 'Runtime shutdown failed');
    }
}
