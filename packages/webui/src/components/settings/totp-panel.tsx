import { useCallback, useEffect, useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal } from '@/components/interior/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/api';
import type { TotpEnrollment, TotpStatus } from '@/lib/api/types';
import { parseSecondFactor } from '@/lib/totp-second-factor';
import { TotpQr } from '@/components/settings/totp-qr';
import { TotpRecoveryCodes } from '@/components/settings/totp-recovery-codes';

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <div className="sm:shrink-0">{children}</div>
    </div>
  );
}

export function TotpPanel() {
  const api = useApi();
  const [status, setStatus] = useState<TotpStatus | 'hidden' | 'loading'>('loading');
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.totp.status());
    } catch {
      setStatus('hidden');
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (status === 'hidden') return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-1 pb-4">
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <ShieldCheck className="size-4 text-primary" />
          双重验证
        </CardTitle>
        <CardDescription className="text-[12px] leading-relaxed">
          登录时在访问密码之外再验证 Authenticator 一次性密码。默认关闭。
        </CardDescription>
      </CardHeader>
      <div className="divide-y divide-border/60 border-t border-border/60">
        {status === 'loading' ? (
          <SettingRow label="2FA" hint="正在读取…">
            <span className="text-sm text-muted-foreground">…</span>
          </SettingRow>
        ) : status.enabled ? (
          <>
            <SettingRow label="状态" hint={`已绑定 ${status.label} · 剩余 ${status.remainingRecoveryCodes} 个恢复码`}>
              <span className="text-sm text-success">已开启</span>
            </SettingRow>
            <SettingRow label="恢复码" hint="重新生成后旧码立即作废。">
              <Button variant="outline" size="sm" onClick={() => setRegenOpen(true)}>
              重新生成
              </Button>
            </SettingRow>
            <SettingRow label="关闭 2FA" hint="需要当前密码，以及验证码或恢复码。其他设备的会话将失效。">
              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDisableOpen(true)}>
              关闭
              </Button>
            </SettingRow>
          </>
        ) : (
          <SettingRow label="Authenticator" hint="扫描二维码或手动输入密钥，再用 6 位验证码确认。">
            <Button variant="outline" size="sm" onClick={() => setSetupOpen(true)}>
              <KeyRound className="size-4" /> 开启 2FA
            </Button>
          </SettingRow>
        )}
      </div>

      <TotpSetupDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onEnabled={async () => { await refresh(); }}
      />
      <TotpChallengeDialog
        open={disableOpen}
        onOpenChange={setDisableOpen}
        title="关闭双重验证"
        description="关闭后，只需访问密码即可登录。其他已登录会话会立即失效。"
        confirmText="关闭 2FA"
        destructive
        onSubmit={async (password, second) => api.totp.disable(password, second)}
        onDone={refresh}
      />
      <TotpRegenDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        onDone={refresh}
      />
    </Card>
  );
}

function TotpSetupDialog({
  open,
  onOpenChange,
  onEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void | Promise<void>;
}) {
  const api = useApi();
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [issuer, setIssuer] = useState('');
  const [accountName, setAccountName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const loadEnrollment = useCallback(async (nextIssuer?: string, nextAccount?: string) => {
    const result = await api.totp.begin({
      ...(nextIssuer ? { issuer: nextIssuer } : {}),
      ...(nextAccount ? { accountName: nextAccount } : {}),
    });
    if (!result.success) {
      setError(result.message);
      return;
    }
    setEnrollment(result);
    setIssuer(result.issuer);
    setAccountName(result.accountName);
    setError('');
  }, [api]);

  useEffect(() => {
    if (!open) {
      setEnrollment(null);
      setPassword('');
      setCode('');
      setError('');
      setRecoveryCodes(null);
      return;
    }
    void loadEnrollment();
  }, [open, loadEnrollment]);

  const refreshLabels = async () => {
    if (!enrollment) return;
    await loadEnrollment(issuer, accountName);
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    await loadEnrollment(issuer, accountName);
    const result = await api.totp.confirm(password, code);
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setRecoveryCodes(result.recoveryCodes);
    await onEnabled();
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!recoveryCodes) onOpenChange(false); }}
      title={recoveryCodes ? '保存恢复码' : '开启双重验证'}
      description={recoveryCodes
        ? '这些恢复码只显示一次。丢失 Authenticator 时用它们登录。'
        : '用 Authenticator 扫描二维码，或手动输入密钥，然后输入当前访问密码和 6 位验证码。'}
      closeLabel="关闭 2FA 绑定"
      maxWidth={440}
    >
      {recoveryCodes ? (
        <TotpRecoveryCodes codes={recoveryCodes} onConfirm={() => onOpenChange(false)} />
      ) : (
        <div className="flex flex-col gap-4">
          {enrollment && (
            <div className="flex flex-col items-center gap-3">
              <TotpQr value={enrollment.otpauthUrl} label="2FA 绑定二维码" />
              <p className="break-all text-center font-mono text-xs text-muted-foreground">{enrollment.secret}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              服务名
              <Input value={issuer} onChange={(e) => setIssuer(e.target.value)} onBlur={() => { void refreshLabels(); }} />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              账号名
              <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} onBlur={() => { void refreshLabels(); }} />
            </label>
          </div>
          <Input
            type="password"
            placeholder="当前访问密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 位验证码"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" disabled={busy || !password || !code} onClick={() => { void confirm(); }}>
            {busy ? '正在开启…' : '确认开启'}
          </Button>
        </div>
      )}
    </Modal>
  );
}

function TotpChallengeDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  destructive,
  onSubmit,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText: string;
  destructive?: boolean;
  onSubmit: (password: string, second: { totp?: string; recoveryCode?: string }) => Promise<{ success: boolean; message?: string }>;
  onDone: () => void | Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setSecond('');
      setError('');
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError('');
    const result = await onSubmit(password, parseSecondFactor(second));
    setBusy(false);
    if (!result.success) {
      setError(result.message ?? '操作失败');
      return;
    }
    await onDone();
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title={title}
      description={description}
      closeLabel={`关闭${title}`}
      maxWidth={400}
    >
      <div className="flex flex-col gap-3">
        <Input
          type="password"
          placeholder="当前访问密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <Input
          placeholder="6 位验证码或恢复码"
          value={second}
          onChange={(e) => setSecond(e.target.value)}
          autoComplete="one-time-code"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          type="button"
          variant={destructive ? 'destructive' : 'default'}
          disabled={busy || !password || !second.trim()}
          onClick={() => { void submit(); }}
        >
          {busy ? '处理中…' : confirmText}
        </Button>
      </div>
    </Modal>
  );
}

function TotpRegenDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void | Promise<void>;
}) {
  const api = useApi();
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setTotp('');
      setError('');
      setCodes(null);
    }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError('');
    const result = await api.totp.regenerateRecoveryCodes(password, totp.trim());
    setBusy(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setCodes(result.recoveryCodes);
    await onDone();
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!codes) onOpenChange(false); }}
      title={codes ? '新的恢复码' : '重新生成恢复码'}
      description={codes ? '旧恢复码已作废。请保存下面的新码。' : '需要当前密码和 Authenticator 验证码。旧恢复码会立即作废。'}
      closeLabel="关闭恢复码"
      maxWidth={440}
    >
      {codes ? (
        <TotpRecoveryCodes codes={codes} onConfirm={() => onOpenChange(false)} />
      ) : (
        <div className="flex flex-col gap-3">
          <Input
            type="password"
            placeholder="当前访问密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          <Input
            inputMode="numeric"
            placeholder="6 位验证码"
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            autoComplete="one-time-code"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="button" disabled={busy || !password || !totp.trim()} onClick={() => { void submit(); }}>
            {busy ? '正在生成…' : '生成新恢复码'}
          </Button>
        </div>
      )}
    </Modal>
  );
}
