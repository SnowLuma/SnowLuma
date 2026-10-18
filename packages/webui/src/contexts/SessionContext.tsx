import { createContext, useContext, type ReactNode } from 'react';

/** Session state shared by the authentication boundary and routed pages. */
export interface SessionValue {
    status: string;
    /** Ends the session and unmounts its page state. */
    onLogoutComplete: () => void;
    /** Replays the first-run wizard without changing persisted account state. */
    restartOnboarding: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ value, children }: { value: SessionValue; children: ReactNode }) {
    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
    const v = useContext(SessionContext);

    if (!v) {
        throw new Error('useSession must be used inside <SessionProvider>');
    }

    return v;
}
