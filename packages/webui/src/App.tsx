import { useCallback, useEffect, useMemo, useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { SessionProvider } from '@/contexts/SessionContext';
import { LoginPage } from '@/components/pages/login-page';
import { ChangePasswordPage } from '@/components/pages/change-password-page';
import { ConsentPage } from '@/components/pages/consent-page';
import { ApiProvider, createApiClient, useApi, type ApiClient } from '@/lib/api';
import { DebugTaskProvider } from '@/contexts/DebugTaskContext';
import { TaskBadge } from '@/components/debug/task-badge';
import { AdaptivePointer } from '@/components/ui/adaptive-pointer';
import { GlobalContextMenu } from '@/components/ui/global-context-menu';
import {
  ActionFeedbackProvider,
  ActionFeedbackViewport,
  useActionFeedback,
} from '@/contexts/ActionFeedbackContext';
import type { AgreementsPayload } from '@/lib/api/types';
import { appRouter } from '@/router';

export default function App() {
  return (
    <ActionFeedbackProvider>
      <ThemeProvider>
        <ActionFeedbackViewport />
        <AdaptivePointer />
        <GlobalContextMenu />
        <AuthBoundary />
      </ThemeProvider>
    </ActionFeedbackProvider>
  );
}

// #194: read a one-shot `?token=<password>` login param and immediately strip
// it from the URL (replaceState) so the credential doesn't linger in the
// address bar / browser history / Referer header. Named `token` to match the
// requested query key; the value is the WebUI login password.
function consumeUrlToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const value = url.searchParams.get('token');
    if (!value) return null;
    url.searchParams.delete('token');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    return value;
  } catch {
    return null;
  }
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
      let ok = await client.status();
      // #194: `?token=<password>` in the URL logs in without typing the
      // password. Only attempted when no stored token already authed us; the
      // value is the WebUI login password (verified by /api/login server-side,
      // so a wrong one just falls through to the login page). The param is
      // consumed once and stripped from the URL first — a password in the
      // address bar leaks via browser history / access logs / the Referer.
      let urlPassword: string | undefined;
      if (!ok) {
        const pw = consumeUrlToken();
        if (pw) {
          const result = await client.login(pw);
          if (result.ok) { ok = true; urlPassword = pw; }
        }
      }
      if (ok) {
        setAuthed(true);
        setStatus('已连接');
        setMustChange(await client.mustChangePassword());
        // Carry the URL password into the forced change-password gate so it
        // needn't re-prompt for the old password (matches the login flow).
        if (urlPassword) setLoginPassword(urlPassword);
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
      <DebugTaskProvider>
        <TooltipProvider delayDuration={150}>{view}</TooltipProvider>
        <TaskBadge />
      </DebugTaskProvider>
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
  const { runAction } = useActionFeedback();
  const handleLogin = useCallback(
    async (password: string) => {
      const result = await runAction(
        {
          title: '正在登录',
          detail: '正在验证 WebUI 访问密码',
          successTitle: '登录成功',
          successDetail: '正在进入控制台',
          errorTitle: '登录失败',
          resultError: (login) => login.ok ? null : login.message,
        },
        () => api.login(password),
      );
      if (!result.ok) return { success: false, error: result.message };
      onAuthed(result.mustChangePassword, password);
      return { success: true };
    },
    [api, onAuthed, runAction],
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
  const { runAction } = useActionFeedback();
  return (
    <ConsentPage
      documents={payload.documents}
      version={payload.version}
      onDecline={onDecline}
      onAccept={async () => {
        const result = await runAction(
          {
            title: '正在记录协议确认',
            detail: `协议版本 ${payload.version.slice(0, 8)}`,
            successTitle: '协议确认已记录',
            errorTitle: '协议确认失败',
            resultError: (consent) => consent.success ? null : consent.message,
          },
          () => api.agreements.recordConsent(payload.version),
        );
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
