import { useCallback, useEffect, useMemo, useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { SessionProvider } from '@/contexts/SessionContext';
import { LoginPage } from '@/components/pages/login-page';
import { ChangePasswordPage } from '@/components/pages/change-password-page';
import { ApiProvider, createApiClient, useApi, type ApiClient } from '@/lib/api';
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

  useEffect(() => {
    (async () => {
      const ok = await client.status();
      if (ok) {
        setAuthed(true);
        setStatus('已连接');
        setMustChange(await client.mustChangePassword());
      }
      setAuthChecked(true);
    })();
  }, [client]);

  const handleLogoutComplete = useCallback(() => {
    // Reset the URL so the next login lands on the overview page, matching
    // the pre-router behaviour.
    window.history.replaceState({}, '', '/');
    setAuthed(false);
    setStatus('未连接');
    setMustChange(false);
  }, []);

  return (
    <ApiProvider client={client}>
      <TooltipProvider delayDuration={150}>
        {!authChecked ? (
          <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
            初始化中…
          </div>
        ) : !authed ? (
          <LoginGate
            onAuthed={(needsChange, password) => {
              setAuthed(true);
              setStatus('已连接');
              setMustChange(needsChange);
              setLoginPassword(password);
            }}
          />
        ) : mustChange ? (
          <ForcedChangePasswordGate
            knownOldPassword={loginPassword}
            onSuccess={() => {
              setMustChange(false);
              setLoginPassword(undefined);
            }}
          />
        ) : (
          <SessionProvider value={{ status, onLogoutComplete: handleLogoutComplete }}>
            <RouterProvider router={appRouter} />
          </SessionProvider>
        )}
      </TooltipProvider>
    </ApiProvider>
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
