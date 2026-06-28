// Settings → 全局配置 tab. Deployment-wide SnowLuma knobs (config/snowluma.json):
// rkey fallback servers + the music-card signing URL. Same UX as the other
// settings panels — debounced auto-save, no explicit save button. Unlike the
// channel editor these are typed inline, so the server's normalized result is
// NOT written back onto the inputs while editing (that would erase a half-typed
// URL); the store reconciles on the next load. Invalid entries are flagged
// client-side and simply dropped by the server on save.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, Music, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { GlobalSettings } from '@/types';

const MUSIC_SIGN_DEFAULT = 'https://ss.xingzhige.com/music_card/card';

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0;
  } catch {
    return false;
  }
}

export function GlobalConfigPanel() {
  const api = useApi();
  const [config, setConfig] = useState<GlobalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const msgTimer = useRef<number | null>(null);
  const saveGen = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setConfig(await api.globalConfig.get());
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (msgTimer.current) clearTimeout(msgTimer.current);
    },
    [],
  );

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setMsg(null), 2400);
  };

  /** Apply locally + debounced auto-save. Deliberately does NOT reconcile the
   *  inputs from the server's normalized response (it would wipe a half-typed
   *  URL); a generation guard just confirms the latest save. */
  const commit = (next: GlobalSettings) => {
    setConfig(next);
    const gen = ++saveGen.current;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.globalConfig
        .save(next)
        .then(() => {
          if (saveGen.current !== gen) return;
          // The server drops invalid (non-http) entries; say so rather than a
          // bare "已保存" next to a still-visible rejected value.
          const dropped = next.rkey.fallbackServers.some((s) => s.trim() && !isHttpUrl(s.trim()))
            || (next.musicSignUrl.trim().length > 0 && !isHttpUrl(next.musicSignUrl.trim()));
          flash('ok', dropped ? '已保存（无效项已忽略）' : '已保存');
        })
        .catch(() => {
          if (saveGen.current !== gen) return;
          flash('err', '保存失败，请检查服务器日志');
        });
    }, 500);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-card/40 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 加载中…
      </div>
    );
  }

  if (loadFailed || !config) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-muted-foreground">
        <AlertTriangle className="size-8 opacity-40" strokeWidth={1.5} />
        <p className="text-sm">加载全局配置失败</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-3.5" /> 重试
        </Button>
      </div>
    );
  }

  const servers = config.rkey.fallbackServers;
  const setServers = (next: string[]) => commit({ ...config, rkey: { fallbackServers: next } });

  return (
    <div className="flex flex-col gap-4">
      {/* rkey fallback servers */}
      <div className="flex flex-col gap-4 rounded-xl border bg-card/40 p-4">
        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          <p>
            图片 / 文件下载链接需要服务器签发的 <code className="font-mono">rkey</code>。SnowLuma 默认走内核获取；
            当内核在你的环境下持续取不到时，会按顺序向这里配置的 HTTP 端点回退。
            <strong className="font-medium text-foreground/80">默认留空＝关闭</strong>，不配置就不会联系任何第三方。
            建议填你自建的端点。
          </p>
        </div>

        <div className="flex flex-col gap-2 border-t pt-3">
          <div className="flex items-center justify-between">
            <Label>rkey 回退服务器</Label>
            <Button variant="outline" size="sm" onClick={() => setServers([...servers, ''])}>
              <Plus className="size-3.5" /> 添加
            </Button>
          </div>

          {servers.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              未配置回退服务器（rkey 回退已关闭）
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {servers.map((url, i) => {
                const invalid = url.trim().length > 0 && !isHttpUrl(url.trim());
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      type="url"
                      inputMode="url"
                      spellCheck={false}
                      placeholder="https://your-rkey-server.example/rkeys"
                      value={url}
                      aria-invalid={invalid}
                      className={cn('font-mono text-xs', invalid && 'border-destructive focus-visible:ring-destructive')}
                      onChange={(e) => setServers(servers.map((s, idx) => (idx === i ? e.target.value : s)))}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="删除"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setServers(servers.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                );
              })}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                端点需返回 <code className="font-mono">{'{ group_rkey, private_rkey, expired_time }'}</code>
                （兼容 NapCat rkey 服务格式）。非 http(s) 链接会被忽略。
              </p>
            </div>
          )}
        </div>
      </div>

      {/* music sign URL */}
      <div className="flex flex-col gap-4 rounded-xl border bg-card/40 p-4">
        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <Music className="mt-0.5 size-3.5 shrink-0" />
          <p>音乐分享卡片的签名服务，对所有账号统一生效。留空则使用内置默认服务。</p>
        </div>
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <Label>音乐签名服务 URL</Label>
          <Input
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder={MUSIC_SIGN_DEFAULT}
            value={config.musicSignUrl}
            aria-invalid={config.musicSignUrl.trim().length > 0 && !isHttpUrl(config.musicSignUrl.trim())}
            className={cn(
              'font-mono text-xs',
              config.musicSignUrl.trim().length > 0 && !isHttpUrl(config.musicSignUrl.trim())
                && 'border-destructive focus-visible:ring-destructive',
            )}
            onChange={(e) => commit({ ...config, musicSignUrl: e.target.value })}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            内置默认：<code className="font-mono">{MUSIC_SIGN_DEFAULT}</code>
          </p>
        </div>
      </div>

      {msg && <p className={cn('text-xs', msg.kind === 'ok' ? 'text-success' : 'text-destructive')}>{msg.text}</p>}
    </div>
  );
}
