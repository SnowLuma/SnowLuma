"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const EASE = [0.23, 1, 0.32, 1] as const;
const EXIT_EASE = [0.4, 0, 1, 1] as const;
const RAIL = { type: "spring", stiffness: 520, damping: 40, mass: 0.5 } as const;
const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;

export type WizardDirection = 1 | -1;

export type UseWizardOptions = {
  total: number;
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number, direction: WizardDirection) => void;
  onComplete?: () => void;
};

function clampIndex(value: number, total: number) {
  if (total < 1) return 0;
  return Math.max(0, Math.min(total - 1, Math.trunc(value)));
}

export function useWizard({
  total,
  index,
  defaultIndex = 0,
  onIndexChange,
  onComplete,
}: UseWizardOptions) {
  const [internal, setInternal] = useState(() => clampIndex(defaultIndex, total));
  const current = clampIndex(index ?? internal, total);
  const [seen, setSeen] = useState<{ index: number; direction: WizardDirection }>({
    index: current,
    direction: 1,
  });
  if (seen.index !== current) {
    setSeen({ index: current, direction: current > seen.index ? 1 : -1 });
  }

  const [furthest, setFurthest] = useState(current);
  if (furthest < current) setFurthest(current);

  const emit = useRef(onIndexChange);
  const finish = useRef(onComplete);
  useEffect(() => {
    emit.current = onIndexChange;
    finish.current = onComplete;
  }, [onIndexChange, onComplete]);

  const controlled = index !== undefined;

  const goTo = useCallback(
    (to: number) => {
      const target = clampIndex(to, total);
      if (target === current) return;
      const direction: WizardDirection = target > current ? 1 : -1;
      if (!controlled) setInternal(target);
      emit.current?.(target, direction);
    },
    [controlled, current, total],
  );

  const next = useCallback(() => {
    if (current >= total - 1) {
      finish.current?.();
      return;
    }
    goTo(current + 1);
  }, [current, goTo, total]);

  const back = useCallback(() => goTo(current - 1), [current, goTo]);

  return {
    index: current,
    direction: seen.direction,
    furthest: Math.min(furthest, Math.max(total - 1, 0)),
    total,
    isFirst: current === 0,
    isLast: current === total - 1,
    next,
    back,
    goTo,
  };
}

export type WizardStep = {
  id: string;
  label: string;
  content: ReactNode;
  canSkip?: boolean;
  onSkip?: () => void;
  hideAdvance?: boolean;
  hideBack?: boolean;
  scrollMode?: "panel" | "content";
};

export type WizardNavigationControls = {
  back: () => void;
  next: () => void;
  goTo: (index: number) => void;
  index: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
};

const WizardNavigationContext = createContext<WizardNavigationControls | null>(null);

export function useWizardNavigation(): WizardNavigationControls {
  const controls = useContext(WizardNavigationContext);
  if (!controls) throw new Error("useWizardNavigation must be used inside <WizardSteps>");
  return controls;
}

export type WizardStepsProps = {
  steps: WizardStep[];
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number, direction: WizardDirection) => void;
  onComplete?: () => void;
  complete?: boolean;
  height?: CSSProperties["height"];
  backLabel?: string;
  nextLabel?: string;
  finishLabel?: string;
  skipLabel?: string;
  completeLabel?: string;
  completeHint?: string;
  label?: string;
  className?: string;
  spacious?: boolean;
  fill?: boolean;
};

export function WizardSteps({
  steps,
  index,
  defaultIndex = 0,
  onIndexChange,
  onComplete,
  complete = false,
  height = 184,
  backLabel = "Back",
  nextLabel = "Next",
  finishLabel = "Finish",
  skipLabel = "Skip",
  completeLabel = "All set",
  completeHint = "Step back to change anything",
  label = "Steps",
  className = "",
  spacious = false,
  fill = false,
}: WizardStepsProps) {
  const wizard = useWizard({
    total: steps.length,
    index,
    defaultIndex,
    onIndexChange,
    onComplete,
  });
  const reduced = useReducedMotion();

  const listRef = useRef<HTMLOListElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const intent = useRef<"list" | "panel" | null>(null);
  const {
    index: at,
    direction,
    furthest,
    total,
    isFirst,
    isLast,
    next,
    back,
    goTo,
  } = wizard;

  useEffect(() => {
    const move = intent.current;
    intent.current = null;
    if (move === "list") {
      listRef.current
        ?.querySelector<HTMLButtonElement>('button[data-current="true"]')
        ?.focus();
      return;
    }
    if (move === "panel") viewportRef.current?.focus({ preventScroll: true });
  }, [at]);

  const variants = useMemo(
    () => ({
      enter: (nextDirection: WizardDirection) => (
        reduced ? { opacity: 0 } : { opacity: 0, x: nextDirection * 22 }
      ),
      center: reduced ? { opacity: 1 } : { opacity: 1, x: 0 },
      exit: (nextDirection: WizardDirection) => (
        reduced
          ? { opacity: 0, transition: { duration: 0 } }
          : {
            opacity: 0,
            x: nextDirection * -22,
            transition: { duration: 0.14, ease: EXIT_EASE },
          }
      ),
    }),
    [reduced],
  );

  const panelTransition = reduced ? { duration: 0 } : CROSSFADE;

  const onStepKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    let target: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = at + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = at - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = furthest;
    else return;
    event.preventDefault();
    target = Math.min(clampIndex(target, total), furthest);
    if (target === at) return;
    intent.current = "list";
    goTo(target);
  };

  const step = steps[at];
  if (!step) return null;

  const position = `Step ${at + 1} of ${total}: ${step.label}`;
  const navigation = {
    back: () => {
      intent.current = "panel";
      back();
    },
    next: () => {
      if (!isLast) intent.current = "panel";
      next();
    },
    goTo,
    index: at,
    total,
    isFirst,
    isLast,
  } satisfies WizardNavigationControls;
  const showBack = !isFirst && !step.hideBack;
  const showSkip = Boolean(step.canSkip);
  const showAdvance = !complete && !step.hideAdvance;
  const showNavigation = showBack || showSkip || showAdvance;

  return (
    <div className={`${fill ? "flex min-h-0 flex-1 flex-col" : ""} w-full ${className}`}>
      <p aria-live="polite" className="sr-only">{position}</p>
      <span
        aria-hidden
        className={`${spacious ? "mb-1 text-sm" : "mb-2 text-[13px]"} grid select-none font-medium text-foreground`}
      >
        {steps.map((candidate, stepIndex) => (
          <motion.span
            key={candidate.id}
            className="col-start-1 row-start-1 truncate"
            initial={false}
            animate={{ opacity: stepIndex === at ? 1 : 0 }}
            transition={reduced ? { duration: 0 } : CROSSFADE}
          >
            {candidate.label}
          </motion.span>
        ))}
      </span>
      <ol
        ref={listRef}
        aria-label={label}
        className={`${spacious ? "mb-3 gap-2" : "mb-4 gap-1"} flex list-none items-center p-0`}
      >
        {steps.map((candidate, stepIndex) => {
          const done = complete || stepIndex < at;
          const here = !complete && stepIndex === at;
          const tile = (
            <motion.span
              aria-hidden
              className={`grid size-7 place-items-center rounded-[8px] border text-[11.5px] font-medium tabular-nums shadow-xs transition-colors duration-150 ${
                done
                  ? "border-foreground bg-foreground text-background"
                  : here
                    ? "border-border bg-background text-foreground"
                    : "border-border bg-background text-muted-foreground"
              }`}
              initial={false}
              animate={{ scale: here ? 1 : 0.92 }}
              transition={reduced ? { duration: 0 } : RAIL}
            >
              {done ? (
                <svg width="12" height="12" viewBox="0 0 256 256" fill="none" aria-hidden="true">
                  <polyline
                    points="216 72 104 184 48 128"
                    stroke="currentColor"
                    strokeWidth="24"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                stepIndex + 1
              )}
            </motion.span>
          );

          return (
            <li key={candidate.id} className="flex flex-1 items-center gap-1 last:flex-none">
              {stepIndex <= furthest ? (
                <button
                  type="button"
                  data-current={here ? "true" : undefined}
                  tabIndex={here ? 0 : -1}
                  aria-current={here ? "step" : undefined}
                  aria-label={`Step ${stepIndex + 1} of ${total}: ${candidate.label}`}
                  onKeyDown={onStepKeyDown}
                  onClick={() => {
                    if (here) return;
                    intent.current = "list";
                    goTo(stepIndex);
                  }}
                  className="relative rounded-[8px] outline-none after:absolute after:-inset-2 after:content-[''] focus-visible:shadow-[0_0_0_1.5px_var(--ring)]"
                >
                  {tile}
                </button>
              ) : (
                <span>
                  <span className="sr-only">
                    {`Step ${stepIndex + 1} of ${total}: ${candidate.label}`}
                  </span>
                  {tile}
                </span>
              )}

              {stepIndex < total - 1 ? (
                <span
                  aria-hidden
                  className="relative h-[3px] flex-1 overflow-hidden rounded-[2px] bg-muted shadow-[inset_0_1px_2px_rgb(0_0_0/0.07)]"
                >
                  <motion.span
                    className="absolute inset-0 origin-left rounded-[2px] bg-foreground"
                    initial={false}
                    animate={{ scaleX: complete || stepIndex < at ? 1 : 0 }}
                    transition={reduced ? { duration: 0 } : RAIL}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div
        ref={viewportRef}
        tabIndex={-1}
        role="group"
        aria-label={position}
        style={{ height: fill ? undefined : height }}
        className={`${fill ? "min-h-0 flex-1" : ""} relative overflow-hidden border border-border bg-card outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-ring ${
          spacious
            ? "rounded-[24px] shadow-[0_0_0_1px_rgb(255_255_255/0.02),0_18px_50px_rgb(0_0_0/0.12)]"
            : "rounded-[11px] shadow-sm"
        }`}
      >
        <AnimatePresence initial={false} custom={direction}>
          <motion.div
            key={complete ? "__complete" : step.id}
            custom={direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={panelTransition}
            style={{ scrollbarGutter: "stable" }}
            className={`absolute inset-0 overscroll-contain text-foreground ${
              step.scrollMode === "content" ? "overflow-hidden" : "overflow-y-auto"
            } ${spacious ? "p-4 text-sm leading-relaxed sm:p-5 lg:p-6" : "p-4 text-[13.5px] leading-relaxed"}`}
          >
            {complete ? (
              <div className="flex h-full flex-col items-center justify-center gap-1.5">
                <p className="text-[13px] font-medium text-foreground">{completeLabel}</p>
                <p className="text-[12.5px] text-muted-foreground">{completeHint}</p>
              </div>
            ) : (
              <WizardNavigationContext.Provider value={navigation}>
                {step.content}
              </WizardNavigationContext.Provider>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      {showNavigation ? <div className={`${spacious ? "mt-4 h-11" : "mt-3 h-9"} flex items-center gap-3`}>
        <AnimatePresence initial={false}>
          {showBack ? (
            <motion.button
              key="back"
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{
                opacity: 0,
                transition: reduced ? { duration: 0 } : { duration: 0.12, ease: EXIT_EASE },
              }}
              transition={reduced ? { duration: 0 } : { duration: 0.16, ease: EASE }}
              onClick={() => {
                navigation.back();
              }}
              className={`${spacious ? "h-11 px-4 text-sm" : "h-9 px-3 text-[13px]"} rounded-[9px] border border-border bg-background font-medium text-foreground outline-none transition-[border-color,box-shadow] duration-150 hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40`}
            >
              {backLabel}
            </motion.button>
          ) : null}
        </AnimatePresence>
        {showSkip ? (
          <motion.button
            key={`skip-${step.id}`}
            type="button"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{
              opacity: 0,
              transition: reduced ? { duration: 0 } : { duration: 0.12, ease: EXIT_EASE },
            }}
            transition={reduced ? { duration: 0 } : { duration: 0.16, ease: EASE }}
            onClick={() => {
              step.onSkip?.();
              if (!isLast) intent.current = "panel";
              next();
            }}
            className={`${spacious ? "h-11 px-4 text-sm" : "h-9 px-3 text-[13px]"} rounded-[9px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40`}
          >
            {skipLabel}
          </motion.button>
        ) : null}
        <AnimatePresence initial={false}>
          {showAdvance ? (
            <motion.button
              key="advance"
              type="button"
              aria-label={isLast ? finishLabel : nextLabel}
              onClick={() => {
                navigation.next();
              }}
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{
                opacity: 0,
                scale: 0.96,
                transition: reduced
                  ? { duration: 0 }
                  : { duration: 0.14, ease: EXIT_EASE },
              }}
              transition={reduced ? { duration: 0 } : CROSSFADE}
              className={`${spacious ? "h-11 px-4 text-sm" : "h-9 px-3.5 text-[13px]"} ml-auto grid place-items-center rounded-[9px] bg-foreground font-medium text-background outline-none focus-visible:shadow-[inset_0_0_0_1.5px_var(--ring)]`}
            >
              <span aria-hidden className="invisible col-start-1 row-start-1">
                {finishLabel.length > nextLabel.length ? finishLabel : nextLabel}
              </span>
              <motion.span
                aria-hidden
                className="col-start-1 row-start-1"
                initial={false}
                animate={{ opacity: isLast ? 0 : 1 }}
                transition={reduced ? { duration: 0 } : CROSSFADE}
              >
                {nextLabel}
              </motion.span>
              <motion.span
                aria-hidden
                className="col-start-1 row-start-1"
                initial={false}
                animate={{ opacity: isLast ? 1 : 0 }}
                transition={reduced ? { duration: 0 } : CROSSFADE}
              >
                {finishLabel}
              </motion.span>
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div> : null}
    </div>
  );
}
