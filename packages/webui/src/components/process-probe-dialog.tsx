import { useCallback, useEffect, useState } from 'react';
import { Eye, Loader2, User, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/lib/api';

interface QqPortLoginInfo {
  port: number;
  uin: string;
  uid?: string;
  nickName?: string;
  loggedIn: boolean;
}

interface ProcessProbeDialogProps {
  pid: number;
  processName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoad?: () => void;
}

function qqAvatarUrl(uin: string) {
  return `/avatar/${encodeURIComponent(uin)}`;
}

export function ProcessProbeDialog({ pid, processName, open, onOpenChange, onLoad }: ProcessProbeDialogProps) {
  const api = useApi();
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<QqPortLoginInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const result = await api.processes.probeLoginInfo(pid);
      setInfo(result as QqPortLoginInfo | null);
      if (!result) {
        setError('未检测到登录信息（端口 9210-9219 无响应）');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '探测失败');
    } finally {
      setLoading(false);
    }
  }, [api.processes, pid]);

  useEffect(() => {
    if (open) {
      probe();
    } else {
      setInfo(null);
      setError(null);
    }
  }, [open, probe]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>查看登录状态</DialogTitle>
          <DialogDescription>
            {processName} (PID {pid})
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-8 text-muted-foreground">
              <UserX className="size-8" strokeWidth={1.5} />
              <p className="text-sm">{error}</p>
            </div>
          )}

          {!loading && info && (
            <div className="space-y-4">
              {info.loggedIn ? (
                <div className="flex items-center gap-4 rounded-lg border bg-card/50 p-4">
                  <Avatar className="size-14">
                    <AvatarImage src={qqAvatarUrl(info.uin)} alt={info.uin} />
                    <AvatarFallback>
                      <User className="size-6" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{info.nickName || info.uin}</span>
                      <Badge variant="success">已登录</Badge>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">UIN: {info.uin}</div>
                    {info.uid && (
                      <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        UID: {info.uid}
                      </div>
                    )}
                    <div className="mt-1 text-xs text-muted-foreground">端口: {info.port}</div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-8 text-muted-foreground">
                  <UserX className="size-8" strokeWidth={1.5} />
                  <div className="text-center">
                    <p className="text-sm font-medium">等待登录</p>
                    <p className="mt-1 text-xs">端口 {info.port} 已响应，但未检测到登录账号</p>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            {!loading && info?.loggedIn && onLoad && (
              <Button size="sm" onClick={onLoad}>
                加载
              </Button>
            )}
            {!loading && (
              <Button size="sm" onClick={probe}>
                <Eye className="size-3.5" /> 重新探测
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
