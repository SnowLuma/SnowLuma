type Listener<TPayload> = (payload: TPayload) => void;

export class Emitter<TEvents extends object> {
    private readonly listeners = new Map<keyof TEvents, Set<Listener<never>>>();

    on<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): () => void {
        let set = this.listeners.get(event);

        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }

        set.add(listener as Listener<never>);
        return () => this.off(event, listener);
    }

    once<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): () => void {
        const off = this.on(event, (payload) => {
            off();
            listener(payload);
        });
        return off;
    }

    off<TKey extends keyof TEvents>(event: TKey, listener: Listener<TEvents[TKey]>): void {
        this.listeners.get(event)?.delete(listener as Listener<never>);
    }

    emit<TKey extends keyof TEvents>(event: TKey, payload: TEvents[TKey]): void {
        const set = this.listeners.get(event);

        if (!set) {
            return;
        }

        for (const listener of [...set]) {
            listener(payload as never);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
