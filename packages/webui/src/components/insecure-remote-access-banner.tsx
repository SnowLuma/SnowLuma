import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { shouldWarnAboutInsecureRemoteAccess } from '@/lib/transport-security';

const DISMISS_KEY = 'snowluma.insecure-remote-access.dismissed.v1';

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch (error) {
    console.warn('failed to read insecure transport notice preference', error);
    return false;
  }
}

export function InsecureRemoteAccessBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const visible = typeof window !== 'undefined'
    && shouldWarnAboutInsecureRemoteAccess(window.location)
    && !dismissed;

  if (!visible) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch (error) {
      console.warn('failed to persist insecure transport notice preference', error);
    }
  };

  return (
    <div
      role="alert"
      className="sticky top-0 z-[100] flex items-center justify-center gap-3 border-b border-amber-500/35 bg-amber-100 px-4 py-2.5 text-sm text-amber-950 shadow-sm dark:bg-amber-950 dark:text-amber-100"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <p className="max-w-4xl leading-relaxed">
        当前页面通过远程 HTTP 访问，登录凭据和操作内容可能被同网络设备读取；请在设置中启用 HTTPS，或通过受信任的 HTTPS 反向代理访问。
      </p>
      <button
        type="button"
        aria-label="关闭远程 HTTP 访问提醒"
        className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
        onClick={dismiss}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
