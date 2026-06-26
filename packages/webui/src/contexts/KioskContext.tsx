import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// Kiosk ("展示模式"): a chrome-free full-screen view for dashboards on a wall
// display. Entered via `?kiosk=1` or the top-bar button; exited via Esc or the
// corner button. Sticky for the session (sessionStorage) so in-app navigation
// keeps it. Purely cosmetic — it never touches auth or issues any token.

const KIOSK_KEY = 'snowluma_kiosk';

function readInitial(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('kiosk') === '1') {
      sessionStorage.setItem(KIOSK_KEY, '1');
      // Strip the param so a later reload (after exiting) doesn't re-enter.
      const url = new URL(window.location.href);
      url.searchParams.delete('kiosk');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      return true;
    }
    return sessionStorage.getItem(KIOSK_KEY) === '1';
  } catch {
    return false;
  }
}

interface KioskValue {
  kiosk: boolean;
  enter: () => void;
  exit: () => void;
}

const KioskContext = createContext<KioskValue | null>(null);

export function KioskProvider({ children }: { children: ReactNode }) {
  const [kiosk, setKiosk] = useState(readInitial);

  const enter = useCallback(() => {
    try { sessionStorage.setItem(KIOSK_KEY, '1'); } catch { /* private mode */ }
    setKiosk(true);
  }, []);
  const exit = useCallback(() => {
    try { sessionStorage.removeItem(KIOSK_KEY); } catch { /* private mode */ }
    setKiosk(false);
  }, []);

  // Reflect onto <html data-kiosk> so CSS can hide chrome (e.g. the overview
  // edit entry), and bind Esc-to-exit only while active.
  useEffect(() => {
    document.documentElement.setAttribute('data-kiosk', kiosk ? '1' : '0');
    if (!kiosk) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') exit(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kiosk, exit]);

  return <KioskContext.Provider value={{ kiosk, enter, exit }}>{children}</KioskContext.Provider>;
}

export function useKiosk(): KioskValue {
  const ctx = useContext(KioskContext);
  if (!ctx) throw new Error('useKiosk must be used within KioskProvider');
  return ctx;
}
