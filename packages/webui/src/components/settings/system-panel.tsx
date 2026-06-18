// Settings → 服务 tab (Wave A1). Edits the WebUI listener's own config
// (port / bind host / trust-proxy / HTTPS). Listener-level changes are
// persisted but apply only after a restart — there is no supervisor to
// self-restart, so we never offer a "restart now" button, only a banner.
// Fields currently pinned by SNOWLUMA_* env vars are flagged (edits to them
// won't take effect until the env var is removed).
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, Loader2, Lock, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { SystemSettingsResponse } from '@/types';

const TEXTAREA_CLS =
  'w-full min-h-28 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs ' +
  'outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function SystemPanel() {
  const api = useApi();
  const [data, setData] = useState<SystemSettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // editable form state
  const [port, setPort] = useState('');
  const [host, setHost] = useState('0.0.0.0');
  const [trustProxy, setTrustProxy] = useState('');
  const [tlsEnabled, setTlsEnabled] = useState(false);
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');

  const load = async () => {
    try {
      const res = await api.systemSettings.get();
      setData(res);
      setPort(String(res.settings.webuiPort));
      setHost(res.settings.webuiHost);
      setTrustProxy(res.settings.trustProxy);
      setTlsEnabled(res.settings.tlsEnabled);
    } catch {
      setMsg({ kind: 'err', text: '加载系统设置失败' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const overridden = (field: string) => data?.envOverrides.includes(field) ?? false;
  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg(null), 4000);
  };

  const saveSettings = async () => {
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) {
      flash('err', '端口必须是 1–65535 的整数');
      return;
    }
    setSaving(true);
    try {
      await api.systemSettings.save({ webuiPort: portNum, webuiHost: host.trim(), trustProxy, tlsEnabled });
      await load();
      flash('ok', '已保存，重启 SnowLuma 后生效');
    } catch (e) {
      flash('err', e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const uploadCert = async () => {
    if (!certPem.trim() || !keyPem.trim()) { flash('err', '请同时填入证书与私钥'); return; }
    setSaving(true);
    try {
      await api.systemSettings.uploadCert(certPem, keyPem);
      setCertPem(''); setKeyPem('');
      await load();
      flash('ok', '证书已保存，重启后生效');
    } catch (e) {
      flash('err', e instanceof Error ? e.message : '证书保存失败');
    } finally {
      setSaving(false);
    }
  };

  const deleteCert = async () => {
    setSaving(true);
    try {
      await api.systemSettings.deleteCert();
      await load();
      flash('ok', '证书已删除');
    } catch (e) {
      flash('err', e instanceof Error ? e.message : '删除失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 px-1 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 加载中…</div>;
  }

  const EnvBadge = ({ field }: { field: string }) =>
    overridden(field)
      ? <Badge variant="secondary" className="ml-2 gap-1 text-[10px]"><Lock className="h-3 w-3" /> 被环境变量覆盖</Badge>
      : null;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5">
      {/* restart-to-apply notice */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>监听相关设置（端口 / 绑定地址 / HTTPS）属服务级配置，保存后需<strong>重启 SnowLuma</strong> 才生效；本机无自动重启。</span>
      </div>

      {msg && (
        <div className={cn('rounded-lg px-3 py-2 text-xs', msg.kind === 'ok'
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : 'bg-red-500/10 text-red-700 dark:text-red-300')}>{msg.text}</div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">服务监听</CardTitle>
          <CardDescription>WebUI 当前监听端口：{data?.listeningPort}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center">端口<EnvBadge field="webuiPort" /></Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="5099" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center">绑定地址<EnvBadge field="webuiHost" /></Label>
            <select
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="0.0.0.0">0.0.0.0（所有网卡）</option>
              <option value="127.0.0.1">127.0.0.1（仅本机）</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="flex items-center">信任代理 (trust-proxy)<EnvBadge field="trustProxy" /></Label>
            <Input value={trustProxy} onChange={(e) => setTrustProxy(e.target.value)} placeholder="留空=只信任 socket 对端；1=信任反代头" />
            <p className="text-[11px] text-muted-foreground">仅在 WebUI 位于受信任反向代理之后时才设为 1 / loopback / IP 列表。</p>
          </div>
          <div>
            <Button onClick={saveSettings} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4" /> HTTPS / TLS
          </CardTitle>
          <CardDescription>
            {data?.hasCert ? '已安装证书。' : '尚未安装证书。'} 启用 TLS 需先安装有效的证书与私钥（PEM）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <Label>启用 HTTPS</Label>
            <ToggleSwitch value={tlsEnabled} onChange={setTlsEnabled} ariaLabel="启用 HTTPS" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>证书 (cert.pem)</Label>
            <textarea className={TEXTAREA_CLS} value={certPem} onChange={(e) => setCertPem(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>私钥 (key.pem)</Label>
            <textarea className={TEXTAREA_CLS} value={keyPem} onChange={(e) => setKeyPem(e.target.value)} placeholder="-----BEGIN PRIVATE KEY-----" />
          </div>
          <div className="flex gap-2">
            <Button onClick={uploadCert} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} 保存证书
            </Button>
            {data?.hasCert && (
              <Button variant="outline" onClick={deleteCert} disabled={saving} className="gap-1.5">
                <Trash2 className="h-4 w-4" /> 删除证书
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            私钥仅写入服务器 config/key.pem，不会回显。证书无效时保存会被拒绝；若启用了 TLS 但证书加载失败，启动时会自动回退到 HTTP。
          </p>
        </CardContent>
      </Card>
    </motion.div>
  );
}
