import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { motion } from 'motion/react';
import {
  CollapsibleBanner,
  type BannerState,
} from '@/components/interior/collapsible-banner';
import {
  LiveActivity,
  useLiveActivity,
  type ActivityInput,
} from '@/components/interior/live-activity';

type ResultDetail<T> = string | ((result: T) => string | undefined);
type ErrorDetail = string | ((error: unknown) => string);

export interface ActionFeedbackOptions<T = void> extends ActivityInput {
  successTitle?: string;
  successDetail?: ResultDetail<T>;
  errorTitle?: string;
  errorDetail?: ErrorDetail;
  /** Re-show a successful result after an imminent full-page reload. */
  surviveReload?: boolean;
  /**
   * Some APIs resolve transport-successfully while reporting a failed domain
   * result. Return its user-facing reason here so the activity ends in error
   * without changing the caller's result/control flow.
   */
  resultError?: (result: T) => string | null | undefined;
}

export interface ActionFeedbackHandle {
  update: (patch: Partial<ActivityInput>) => void;
  succeed: (patch?: Partial<ActivityInput>) => void;
  fail: (detail: string, patch?: Partial<ActivityInput>) => void;
}

interface ActionFeedbackValue {
  startAction: (input: ActivityInput) => ActionFeedbackHandle;
  runAction: <T>(options: ActionFeedbackOptions<T>, action: () => Promise<T> | T) => Promise<T>;
  activity: ReturnType<typeof useLiveActivity>['activity'];
  notices: ActionNotice[];
  removeNotice: (id: number) => void;
  dismiss: () => void;
}

interface ActionNotice {
  id: number;
  tone: 'success' | 'error';
  title: string;
  detail?: string;
}

const ActionFeedbackContext = createContext<ActionFeedbackValue | null>(null);
const RESULT_NOTICE_DURATION_MS = 5_000;
const RELOAD_NOTICE_MAX_AGE_MS = 30_000;
const RELOAD_NOTICE_KEY = 'snowluma_action_feedback_reload_notice';

interface ReloadNotice extends Omit<ActionNotice, 'id'> {
  createdAt: number;
}

function preserveReloadNotice(notice: Omit<ActionNotice, 'id'>): void {
  try {
    sessionStorage.setItem(
      RELOAD_NOTICE_KEY,
      JSON.stringify({ ...notice, createdAt: Date.now() } satisfies ReloadNotice),
    );
  } catch (error) {
    console.error('preserve action feedback across reload failed', error);
  }
}

function takeReloadNotice(): Omit<ActionNotice, 'id'> | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(RELOAD_NOTICE_KEY);
    sessionStorage.removeItem(RELOAD_NOTICE_KEY);
  } catch (error) {
    console.error('read action feedback after reload failed', error);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReloadNotice>;
    if (
      (parsed.tone !== 'success' && parsed.tone !== 'error')
      || typeof parsed.title !== 'string'
      || typeof parsed.createdAt !== 'number'
      || Date.now() - parsed.createdAt > RELOAD_NOTICE_MAX_AGE_MS
    ) {
      throw new Error('invalid or expired reload notice');
    }
    return {
      tone: parsed.tone,
      title: parsed.title,
      ...(typeof parsed.detail === 'string' ? { detail: parsed.detail } : {}),
    };
  } catch (error) {
    console.error('parse action feedback after reload failed', error);
    return null;
  }
}

export function actionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '未知错误';
}

function resolveResultDetail<T>(detail: ResultDetail<T> | undefined, result: T): string | undefined {
  return typeof detail === 'function' ? detail(result) : detail;
}

function resolveErrorDetail(detail: ErrorDetail | undefined, error: unknown): string {
  if (typeof detail === 'function') return detail(error);
  return detail ?? actionErrorMessage(error);
}

export function publishActionResult(
  ownsSurface: boolean,
  updateCurrentActivity: () => void,
  publishNotice: () => void,
): void {
  if (ownsSurface) updateCurrentActivity();
  publishNotice();
}

export function scheduleActionNoticeDismiss(onDismiss: () => void): () => void {
  const timeout = setTimeout(onDismiss, RESULT_NOTICE_DURATION_MS);
  return () => clearTimeout(timeout);
}

export function ActionFeedbackProvider({ children }: { children: ReactNode }) {
  const {
    activity,
    start,
    update,
    succeed,
    fail,
    dismiss: dismissActivity,
  } = useLiveActivity();
  const activeId = useRef<string | null>(null);
  const noticeId = useRef(0);
  const [notices, setNotices] = useState<ActionNotice[]>([]);

  const pushNotice = useCallback((notice: Omit<ActionNotice, 'id'>) => {
    const next = { ...notice, id: ++noticeId.current };
    setNotices((current) => [...current.slice(-2), next]);
  }, []);

  useEffect(() => {
    const notice = takeReloadNotice();
    if (notice) pushNotice(notice);
  }, [pushNotice]);

  const startAction = useCallback((input: ActivityInput): ActionFeedbackHandle => {
    const id = start(input);
    activeId.current = id;
    const ownsSurface = () => activeId.current === id;

    return {
      update: (patch) => {
        if (ownsSurface()) update(patch);
      },
      succeed: (patch) => {
        publishActionResult(
          ownsSurface(),
          () => succeed(patch),
          () => pushNotice({
            tone: 'success',
            title: patch?.title ?? input.title,
            detail: patch?.detail ?? input.detail,
          }),
        );
      },
      fail: (detail, patch) => {
        publishActionResult(
          ownsSurface(),
          () => fail({ ...patch, detail }),
          () => pushNotice({
            tone: 'error',
            title: patch?.title ?? input.title,
            detail,
          }),
        );
      },
    };
  }, [start, update, succeed, fail, pushNotice]);

  const runAction = useCallback(async <T,>(
    options: ActionFeedbackOptions<T>,
    action: () => Promise<T> | T,
  ): Promise<T> => {
    const {
      successTitle,
      successDetail,
      errorTitle,
      errorDetail,
      resultError,
      surviveReload,
      ...input
    } = options;
    const handle = startAction(input);
    try {
      const result = await action();
      const failed = resultError?.(result);
      if (failed) {
        handle.fail(failed, errorTitle ? { title: errorTitle } : undefined);
      } else {
        const detail = resolveResultDetail(successDetail, result);
        if (surviveReload) {
          preserveReloadNotice({
            tone: 'success',
            title: successTitle ?? input.title,
            detail: detail ?? input.detail,
          });
        }
        handle.succeed({
          ...(successTitle ? { title: successTitle } : {}),
          ...(detail !== undefined ? { detail } : {}),
        });
      }
      return result;
    } catch (error) {
      handle.fail(resolveErrorDetail(errorDetail, error), errorTitle ? { title: errorTitle } : undefined);
      throw error;
    }
  }, [startAction]);

  const dismiss = useCallback(() => {
    activeId.current = null;
    dismissActivity();
  }, [dismissActivity]);

  const removeNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const value = useMemo<ActionFeedbackValue>(
    () => ({ startAction, runAction, activity, notices, removeNotice, dismiss }),
    [startAction, runAction, activity, notices, removeNotice, dismiss],
  );

  return (
    <ActionFeedbackContext.Provider value={value}>
      {children}
    </ActionFeedbackContext.Provider>
  );
}

/**
 * Rendered inside ThemeProvider's MotionConfig so SnowLuma's existing reduced
 * motion / disable-motion preference also reaches Interior's component.
 */
export function ActionFeedbackViewport() {
  const {
    activity,
    notices,
    removeNotice,
    dismiss,
  } = useActionFeedback();
  const runningActivity = activity?.phase === 'running' ? activity : null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(360px,calc(100vw-2rem))] flex-col items-end gap-2">
      {notices.map((notice) => (
        <ActionNoticeBanner
          key={notice.id}
          notice={notice}
          onRemoved={() => removeNotice(notice.id)}
        />
      ))}
      <LiveActivity
        activity={runningActivity}
        onDismiss={dismiss}
        dismissLabel="关闭操作反馈"
        label="操作反馈"
        className="w-full"
      />
    </div>
  );
}

function ActionNoticeBanner({
  notice,
  onRemoved,
}: {
  notice: ActionNotice;
  onRemoved: () => void;
}) {
  const [state, setState] = useState<BannerState>('dismissed');
  const visible = state !== 'dismissed';

  useEffect(() => {
    const frame = requestAnimationFrame(() => setState('open'));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!visible) return;
    return scheduleActionNoticeDismiss(() => setState('dismissed'));
  }, [visible]);

  return (
    <div className="pointer-events-auto relative w-full">
      <CollapsibleBanner
        state={state}
        onStateChange={setState}
        onDismissed={onRemoved}
        title={notice.title}
        description={notice.detail}
        icon={notice.tone === 'success'
          ? <CircleCheck className="size-4 text-success" />
          : <CircleAlert className="size-4 text-destructive" />}
        dismissLabel="关闭通知"
        dismissedMessage="操作通知已关闭。"
        className={notice.tone === 'success'
          ? 'border-success/25'
          : 'border-destructive/30'}
      />
      {state !== 'dismissed' ? (
        <div
          aria-hidden="true"
          data-action-feedback-countdown-track=""
          className="pointer-events-none absolute inset-x-[8px] bottom-0.5 h-[3px] overflow-hidden rounded-full bg-border/45"
        >
          <motion.div
            data-action-feedback-countdown=""
            className={notice.tone === 'success'
              ? 'h-full w-full origin-left rounded-full bg-success shadow-[0_0_5px_color-mix(in_oklab,var(--success)_45%,transparent)]'
              : 'h-full w-full origin-left rounded-full bg-destructive shadow-[0_0_5px_color-mix(in_oklab,var(--destructive)_45%,transparent)]'}
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ duration: RESULT_NOTICE_DURATION_MS / 1_000, ease: 'linear' }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function useActionFeedback(): ActionFeedbackValue {
  const value = useContext(ActionFeedbackContext);
  if (!value) throw new Error('useActionFeedback must be used within ActionFeedbackProvider');
  return value;
}
