"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { FloatingLabelInput } from "@/components/interior/floating-label";

const CROSSFADE = { type: "spring", stiffness: 260, damping: 34, mass: 0.8 } as const;
const INSTANT = { duration: 0 } as const;

const LINE = 16;

export type ValidationStatus = "idle" | "pending" | "valid" | "invalid";

export type Validator = (value: string) => string | null;

export type UseInlineValidationOptions = {
  value: string;
  validate: Validator;
  debounce?: number;
  validationKey?: unknown;
};

export type UseInlineValidationReturn = {
  status: ValidationStatus;
  error: string | null;
  message: string;
  touched: boolean;
  commit: () => void;
  reset: () => void;
  fieldProps: {
    onBlur: () => void;
    "aria-invalid": boolean;
  };
};

type Settled = {
  status: ValidationStatus;
  error: string | null;
  message: string;
};

const CLEAN: Settled = { status: "idle", error: null, message: "" };

export function useInlineValidation({
  value,
  validate,
  debounce = 400,
  validationKey,
}: UseInlineValidationOptions): UseInlineValidationReturn {
  const [touched, setTouched] = useState(false);
  const [settled, setSettled] = useState<Settled>(CLEAN);

  const check = useRef(validate);
  const latest = useRef(value);

  useEffect(() => {
    check.current = validate;
    latest.current = value;
  });

  useEffect(() => {
    if (!touched) return;

    const next = check.current(value);
    const resolved: ValidationStatus = value.length > 0 ? "valid" : "idle";

    if (next === null) {
      setSettled((prev) =>
        prev.status === resolved && prev.error === null
          ? prev
          : { status: resolved, error: null, message: prev.message },
      );
      return;
    }

    setSettled((prev) =>
      prev.status === "invalid"
        ? prev
        : { status: "pending", error: null, message: prev.message },
    );

    const t = setTimeout(() => {
      setSettled((prev) =>
        prev.error === next ? prev : { status: "invalid", error: next, message: next },
      );
    }, debounce);

    return () => clearTimeout(t);
  }, [value, touched, debounce, validationKey]);

  const commit = useCallback(() => {
    setTouched(true);
    const v = latest.current;
    const next = check.current(v);
    setSettled((prev) =>
      next === null
        ? { status: v.length > 0 ? "valid" : "idle", error: null, message: prev.message }
        : { status: "invalid", error: next, message: next },
    );
  }, []);

  const reset = useCallback(() => {
    setTouched(false);
    setSettled(CLEAN);
  }, []);

  return {
    status: settled.status,
    error: settled.error,
    message: settled.message,
    touched,
    commit,
    reset,
    fieldProps: { onBlur: commit, "aria-invalid": settled.status === "invalid" },
  };
}

export type InlineValidationProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  validate: Validator;
  hint?: string;
  id?: string;
  name?: string;
  type?: "text" | "email" | "password" | "tel" | "url" | "search";
  autoComplete?: string;
  inputMode?: React.ComponentProps<"input">["inputMode"];
  debounce?: number;
  validationKey?: unknown;
  reserveLines?: number;
  disabled?: boolean;
  required?: boolean;
  spellCheck?: boolean;
  endAdornment?: React.ReactNode;
  showValidIcon?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
};

export function InlineValidation({
  label,
  value,
  onChange,
  validate,
  hint,
  id,
  name,
  type = "text",
  autoComplete,
  inputMode,
  debounce = 400,
  validationKey,
  reserveLines = 1,
  disabled = false,
  required = false,
  spellCheck,
  endAdornment,
  showValidIcon = true,
  onFocus,
  onBlur,
  className = "",
}: InlineValidationProps) {
  const reduced = useReducedMotion();
  const fade = reduced ? INSTANT : CROSSFADE;

  const auto = useId();
  const fieldId = id ?? `${auto}-field`;
  const hintId = `${auto}-hint`;
  const errorId = `${auto}-error`;

  const { status, error, message, fieldProps } = useInlineValidation({
    value,
    validate,
    debounce,
    validationKey,
  });

  const invalid = status === "invalid";
  const valid = status === "valid";

  const described = [hint ? hintId : null, invalid ? errorId : null]
    .filter(Boolean)
    .join(" ");

  const clamp = {
    display: "-webkit-box" as const,
    WebkitBoxOrient: "vertical" as const,
    WebkitLineClamp: reserveLines,
    overflow: "hidden" as const,
  };

  const statusGlyph = (
    <span
      className="pointer-events-none grid size-3.5 shrink-0 place-items-center"
      aria-hidden
    >
      <motion.svg
        viewBox="0 0 12 12"
        width="14"
        height="14"
        fill="none"
        className="col-start-1 row-start-1 text-success"
        initial={false}
        animate={{
          opacity: showValidIcon && valid ? 1 : 0,
          scale: showValidIcon && valid ? 1 : 0.7,
        }}
        transition={fade}
      >
        <path
          d="M2 6.3 4.7 9 10 3.2"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </motion.svg>
      <motion.svg
        viewBox="0 0 12 12"
        width="14"
        height="14"
        fill="none"
        className="col-start-1 row-start-1 text-destructive"
        initial={false}
        animate={{ opacity: invalid ? 1 : 0, scale: invalid ? 1 : 0.7 }}
        transition={fade}
      >
        <path d="M6 2v4.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <rect x="5.15" y="8.4" width="1.7" height="1.7" rx="0.5" fill="currentColor" />
      </motion.svg>
    </span>
  );

  return (
    <div className={`w-full ${className}`}>
      <FloatingLabelInput
        id={fieldId}
        label={label}
        name={name}
        type={type}
        value={value}
        autoComplete={autoComplete}
        inputMode={inputMode}
        disabled={disabled}
        required={required}
        spellCheck={spellCheck}
        invalid={invalid}
        ariaDescribedBy={described || undefined}
        reserveHintSpace={false}
        onFocus={onFocus}
        onBlur={() => {
          fieldProps.onBlur();
          onBlur?.();
        }}
        onChange={onChange}
        endAdornment={(
          <div className="flex items-center gap-1">
            {statusGlyph}
            {endAdornment}
          </div>
        )}
      />

      <div className="relative mt-1.5 grid" style={{ height: reserveLines * LINE }}>
        {hint ? (
          <motion.p
            aria-hidden
            style={clamp}
            className="col-start-1 row-start-1 text-[11.5px] leading-[16px] text-muted-foreground"
            initial={false}
            animate={{ opacity: invalid ? 0 : 1, y: invalid ? 3 : 0 }}
            transition={fade}
          >
            {hint}
          </motion.p>
        ) : null}

        <motion.p
          aria-hidden
          style={clamp}
          className="col-start-1 row-start-1 text-[11.5px] leading-[16px] text-destructive"
          initial={false}
          animate={{ opacity: invalid ? 1 : 0, y: invalid ? 0 : -3 }}
          transition={fade}
        >
          {error ?? message}
        </motion.p>

        {hint ? (
          <span id={hintId} className="sr-only">
            {hint}
          </span>
        ) : null}

        <span
          id={errorId}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {error ?? ""}
        </span>
      </div>
    </div>
  );
}
