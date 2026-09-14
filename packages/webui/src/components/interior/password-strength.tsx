"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const CELL = { type: "spring", stiffness: 520, damping: 34, mass: 0.45 } as const;
const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;
const INSTANT = { duration: 0 } as const;

const COMMON = /^(?:password|passw0rd|qwerty|letmein|welcome|admin|iloveyou|monkey|dragon|abc123|111111|123123|123456)/i;
const RUN = /(.)\1{3,}/;
const RUN_UP = /(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|defg|qwer|wert|erty|asdf)/i;
const SYMBOL = /[!-/:-@[-`{-~]/;

export type PasswordRule = {
  id: string;
  label: string;
  test: (value: string) => boolean;
};

export type EvaluatedRule = PasswordRule & { met: boolean };

export type UsePasswordStrengthOptions = {
  rules?: readonly PasswordRule[];
  labels?: readonly string[];
  announceDelay?: number;
};

export type PasswordStrengthState = {
  score: number;
  max: number;
  label: string;
  rules: EvaluatedRule[];
  guessable: boolean;
  announcement: string;
};

export const defaultPasswordRules: readonly PasswordRule[] = [
  { id: "length", label: "至少 12 个字符", test: (v) => v.length >= 12 },
  {
    id: "case",
    label: "同时包含大写和小写字母",
    test: (v) => /[a-z]/.test(v) && /[A-Z]/.test(v),
  },
  { id: "digit", label: "包含数字", test: (v) => /\d/.test(v) },
  { id: "symbol", label: "包含特殊符号", test: (v) => SYMBOL.test(v) },
];

const defaultLabels = ["未输入", "弱", "一般", "良好", "强"] as const;

export function usePasswordStrength(
  value: string,
  {
    rules = defaultPasswordRules,
    labels = defaultLabels,
    announceDelay = 700,
  }: UsePasswordStrengthOptions = {},
): PasswordStrengthState {
  const state = useMemo(() => {
    const evaluated = rules.map((rule) => ({ ...rule, met: rule.test(value) }));
    const passed = evaluated.reduce((n, r) => n + (r.met ? 1 : 0), 0);
    const guessable =
      value.length > 0 && (COMMON.test(value) || RUN.test(value) || RUN_UP.test(value));

    const score =
      value.length === 0 ? 0 : guessable ? 1 : Math.min(rules.length, Math.max(1, passed));

    const label = labels[Math.min(score, labels.length - 1)] ?? "";
    const unmet = evaluated.filter((r) => !r.met);

    const announcement =
      value.length === 0
        ? ""
        : [
          `密码强度${label}。`,
          guessable ? "这是容易被猜中的常见模式。" : "",
          unmet.length === 0
            ? "已满足全部要求。"
            : `仍需满足：${unmet.map((r) => r.label).join("、")}。`,
        ]
          .filter(Boolean)
          .join(" ");

    return { score, max: rules.length, label, rules: evaluated, guessable, announcement };
  }, [value, rules, labels]);

  const [settled, setSettled] = useState("");

  useEffect(() => {
    if (state.announcement === "") {
      setSettled("");
      return;
    }
    const id = setTimeout(() => setSettled(state.announcement), announceDelay);
    return () => clearTimeout(id);
  }, [state.announcement, announceDelay]);

  return { ...state, announcement: settled };
}

export type PasswordStrengthProps = {
  value: string;
  rules?: readonly PasswordRule[];
  labels?: readonly string[];
  announceDelay?: number;
  showRules?: boolean;
  visible?: boolean;
  status?: React.ReactNode;
  className?: string;
};

const TONES = {
  none: { bar: "bg-muted-foreground/30", text: "text-muted-foreground" },
  danger: { bar: "bg-destructive", text: "text-destructive" },
  caution: { bar: "bg-warning", text: "text-warning" },
  safe: { bar: "bg-success", text: "text-success" },
} as const;

function toneFor(score: number, max: number) {
  if (score === 0) return TONES.none;
  const ratio = score / max;
  if (ratio <= 0.34) return TONES.danger;
  if (ratio <= 0.67) return TONES.caution;
  return TONES.safe;
}

export function PasswordStrength({
  value,
  rules = defaultPasswordRules,
  labels = defaultLabels,
  announceDelay = 700,
  showRules = true,
  visible = true,
  status,
  className = "",
}: PasswordStrengthProps) {
  const {
    score,
    max,
    label,
    rules: evaluated,
    guessable,
    announcement,
  } = usePasswordStrength(value, { rules, labels, announceDelay });
  const reduced = useReducedMotion();
  const tone = toneFor(score, max);

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key="password-strength"
          initial={reduced ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduced ? INSTANT : CROSSFADE}
          style={{ overflow: "hidden" }}
          className={`w-full ${className}`}
        >
          <div
            role="meter"
            aria-label="密码强度"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={score}
            aria-valuetext={label}
            className="grid gap-1.5"
            style={{ gridTemplateColumns: `repeat(${max}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: max }, (_, i) => (
              <div
                key={i}
                className="relative h-1.5 overflow-hidden rounded-[2px] bg-muted"
              >
                <motion.span
                  className={`absolute inset-0 origin-left rounded-[2px] transition-colors duration-200 ${tone.bar}`}
                  initial={false}
                  animate={{ scaleX: i < score ? 1 : 0 }}
                  transition={
                    reduced ? INSTANT : { ...CELL, delay: i < score ? i * 0.03 : 0 }
                  }
                />
              </div>
            ))}
          </div>

          <div className="mt-2 flex h-5 items-center justify-between gap-3">
            <span className="inline-grid text-[12.5px] font-medium leading-5">
              {labels.map((text, i) => (
                <motion.span
                  key={text}
                  aria-hidden
                  className={`col-start-1 row-start-1 whitespace-nowrap transition-colors duration-200 ${tone.text}`}
                  initial={false}
                  animate={{ opacity: i === Math.min(score, labels.length - 1) ? 1 : 0 }}
                  transition={reduced ? INSTANT : CROSSFADE}
                >
                  {text}
                </motion.span>
              ))}
            </span>

            <motion.span
              aria-hidden
              className="whitespace-nowrap text-[11.5px] leading-5 text-warning"
              initial={false}
              animate={{ opacity: guessable ? 1 : 0 }}
              transition={reduced ? INSTANT : CROSSFADE}
            >
              容易被猜中
            </motion.span>
          </div>

          {showRules && (
            <ul className="mt-3 grid gap-1.5">
              {evaluated.map((rule) => (
                <li key={rule.id} className="flex items-center gap-2">
                  <span className="relative grid size-[14px] shrink-0 place-items-center rounded-[4px] border border-border text-primary-foreground">
                    <motion.span
                      className="absolute inset-0 rounded-[3px] bg-success"
                      initial={false}
                      animate={{ opacity: rule.met ? 1 : 0 }}
                      transition={reduced ? INSTANT : CROSSFADE}
                    />
                    <motion.svg
                      viewBox="0 0 12 12"
                      fill="none"
                      aria-hidden
                      className="relative size-[9px]"
                      initial={false}
                      animate={{ opacity: rule.met ? 1 : 0, scale: rule.met ? 1 : 0.6 }}
                      transition={reduced ? INSTANT : CELL}
                    >
                      <path
                        d="M2 6.2 4.7 8.9 10 3.3"
                        stroke="currentColor"
                        strokeWidth={1.9}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </motion.svg>
                  </span>
                  <span
                    className={`text-[12.5px] leading-5 transition-colors duration-200 ${
                      rule.met ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {rule.label}
                  </span>
                  <span className="sr-only">{rule.met ? "已满足" : "未满足"}</span>
                </li>
              ))}
            </ul>
          )}

          {status ? (
            <div className="mt-2 text-[11.5px] leading-4">
              {status}
            </div>
          ) : null}

          <p aria-live="polite" className="sr-only">
            {announcement}
          </p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
