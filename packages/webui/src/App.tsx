import { useCallback, useEffect, useMemo, useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { SessionProvider } from '@/contexts/SessionContext';
import { LoginPage } from '@/components/pages/login-page';
import { ChangePasswordPage } from '@/components/pages/change-password-page';
import { ConsentPage } from '@/components/pages/consent-page';
import { ApiProvider, createApiClient, useApi, type ApiClient } from '@/lib/api';
import type { AgreementsPayload } from '@/lib/api/types';
import { appRouter } from '@/router';

export default function App() {
  return (
    <ThemeProvider>
      <AuthBoundary />
    </ThemeProvider>
  );
}

function AuthBoundary() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [status, setStatus] = useState('未连接');
  // Agreement consent gate, shown after login but BEFORE the forced password
  // change. `agreements === null` while the post-auth fetch is in flight.
  const [agreements, setAgreements] = useState<AgreementsPayload | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  // The password from *this* session's login, carried into the forced
  // change-password gate so it doesn't have to render an old-password field
  // (which browsers autofill, misleading users on upgrade). Stays undefined
  // for a returning session that's already authed but still must change.
  const [loginPassword, setLoginPassword] = useState<string | undefined>(undefined);

  const client = useMemo<ApiClient>(
    () =>
      createApiClient({
        onUnauthorized: () => {
          setAuthed(false);
          setStatus('未授权');
        },
      }),
    [],
  );

  const refreshAgreements = useCallback(async () => {
    try {
      const payload = await client.agreements.get();
      setAgreements(payload);
      setNeedsConsent(payload.consentRequired);
    } catch {
      // Fail open on a fetch error so a transient hiccup can't wedge the gate.
      setAgreements({ version: '', consentRequired: false, documents: [] });
      setNeedsConsent(false);
    }
  }, [client]);

  useEffect(() => {
    (async () => {
      const ok = await client.status();
      if (ok) {
        setAuthed(true);
        setStatus('已连接');
        setMustChange(await client.mustChangePassword());
        await refreshAgreements();
      }
      setAuthChecked(true);
    })();
  }, [client, refreshAgreements]);

  const handleLoggedOut = useCallback(() => {
    // Reset the URL so the next login lands on the overview page, matching
    // the pre-router behaviour, and clear every post-auth gate.
    window.history.replaceState({}, '', '/');
    setAuthed(false);
    setStatus('未连接');
    setMustChange(false);
    setAgreements(null);
    setNeedsConsent(false);
    setLoginPassword(undefined);
  }, []);

  const handleDecline = useCallback(async () => {
    await client.logout();
    handleLoggedOut();
  }, [client, handleLoggedOut]);

  let view: React.ReactNode;
  if (!authChecked) {
    view = <Splash>初始化中…</Splash>;
  } else if (!authed) {
    view = (
      <LoginGate
        onAuthed={(needsChange, password) => {
          setAuthed(true);
          setStatus('已连接');
          setMustChange(needsChange);
          setLoginPassword(password);
          void refreshAgreements();
        }}
      />
    );
  } else if (agreements === null) {
    view = <Splash>加载中…</Splash>;
  } else if (needsConsent) {
    view = (
      <ConsentGate
        payload={agreements}
        onAccepted={() => setNeedsConsent(false)}
        onStale={refreshAgreements}
        onDecline={handleDecline}
      />
    );
  } else if (mustChange) {
    view = (
      <ForcedChangePasswordGate
        knownOldPassword={loginPassword}
        onSuccess={() => {
          setMustChange(false);
          setLoginPassword(undefined);
        }}
      />
    );
  } else {
    view = (
      <SessionProvider value={{ status, onLogoutComplete: handleLoggedOut }}>
        <RouterProvider router={appRouter} />
      </SessionProvider>
    );
  }

  return (
    <ApiProvider client={client}>
      <TooltipProvider delayDuration={150}>{view}</TooltipProvider>
    </ApiProvider>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function LoginGate({ onAuthed }: { onAuthed: (mustChange: boolean, password: string) => void }) {
  const api = useApi();
  const handleLogin = useCallback(
    async (password: string) => {
      const result = await api.login(password);
      if (!result.ok) return { success: false, error: result.message };
      onAuthed(result.mustChangePassword, password);
      return { success: true };
    },
    [api, onAuthed],
  );
  return <LoginPage onLogin={handleLogin} />;
}

function ConsentGate({
  payload,
  onAccepted,
  onStale,
  onDecline,
}: {
  payload: AgreementsPayload;
  onAccepted: () => void;
  onStale: () => void;
  onDecline: () => void;
}) {
  const api = useApi();
  return (
    <ConsentPage
      documents={payload.documents}
      version={payload.version}
      onDecline={onDecline}
      onAccept={async () => {
        const result = await api.agreements.recordConsent(payload.version);
        if (result.success) {
          onAccepted();
          return { success: true };
        }
        // 409: the agreement text changed under us — re-fetch and re-prompt.
        if (result.currentVersion && result.currentVersion !== payload.version) {
          onStale();
          return { success: false, message: '协议已更新，已为你载入最新版本，请重新阅读后确认。' };
        }
        return { success: false, message: result.message ?? '提交失败，请重试' };
      }}
    />
  );
}

function ForcedChangePasswordGate({
  knownOldPassword,
  onSuccess,
}: {
  knownOldPassword?: string;
  onSuccess: () => void;
}) {
  const api = useApi();
  return (
    <ChangePasswordPage
      knownOldPassword={knownOldPassword}
      checkStrength={(p) => api.checkPasswordStrength(p)}
      submit={(o, n) => api.changePassword(o, n)}
      onSuccess={onSuccess}
    />
  );
}
