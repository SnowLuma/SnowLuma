"use client";

import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "motion/react";

const INSTANT = { duration: 0 } as const;

const LIFT = { type: "spring", stiffness: 760, damping: 46, mass: 0.5 } as const;

const RAISE = -32;
const SLIDE = -12;
const SHRINK = 0.92;

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

export type UseFloatingLabelOptions = {
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
};

export type UseFloatingLabelReturn = {
  ref: React.RefObject<HTMLInputElement | null>;
  raised: boolean;
  focused: boolean;
  filled: boolean;
  length: number;
  instant: boolean;
  fieldProps: {
    onFocus: () => void;
    onBlur: () => void;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  };
};

type Fill = { length: number; instant: boolean };

export function useFloatingLabel({
  value,
  defaultValue,
  disabled = false,
}: UseFloatingLabelOptions = {}): UseFloatingLabelReturn {
  const ref = useRef<HTMLInputElement | null>(null);
  const mounted = useRef(false);

  const [focused, setFocused] = useState(false);
  const [fill, setFill] = useState<Fill>({
    length: (value ?? defaultValue ?? "").length,
    instant: true,
  });

  const settle = useCallback((next: number, instant: boolean) => {
    setFill((prev) =>
      prev.length === next && prev.instant === instant ? prev : { length: next, instant },
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    const next = value !== undefined ? value.length : el ? el.value.length : 0;
    settle(next, !mounted.current);
    mounted.current = true;
  }, [value, settle]);

  useEffect(() => {
    setFill((prev) => (prev.instant ? { ...prev, instant: false } : prev));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || value !== undefined) return;
    const read = () => settle(el.value.length, false);
    el.addEventListener("input", read);
    el.addEventListener("change", read);
    return () => {
      el.removeEventListener("input", read);
      el.removeEventListener("change", read);
    };
  }, [value, settle]);

  useEffect(() => {
    if (disabled) setFocused(false);
  }, [disabled]);

  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      settle(event.currentTarget.value.length, false),
    [settle],
  );

  return {
    ref,
    raised: focused || fill.length > 0,
    focused,
    filled: fill.length > 0,
    length: fill.length,
    instant: fill.instant && !focused,
    fieldProps: { onFocus, onBlur, onChange },
  };
}

export type FloatingLabelInputProps = {
  label: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string, event: React.ChangeEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  hint?: string;
  invalid?: boolean;
  id?: string;
  name?: string;
  type?: "text" | "email" | "password" | "search" | "tel" | "url";
  autoComplete?: string;
  inputMode?: React.ComponentProps<"input">["inputMode"];
  maxLength?: number;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  spellCheck?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  endAdornment?: React.ReactNode;
  ariaDescribedBy?: string;
  reserveHintSpace?: boolean;
  className?: string;
};

export function FloatingLabelInput({
  label,
  value,
  defaultValue,
  onChange,
  onFocus,
  onBlur,
  hint,
  invalid = false,
  id,
  name,
  type = "text",
  autoComplete,
  inputMode,
  maxLength,
  required = false,
  disabled = false,
  readOnly = false,
  spellCheck,
  inputRef,
  endAdornment,
  ariaDescribedBy,
  reserveHintSpace = true,
  className = "",
}: FloatingLabelInputProps) {
  const auto = useId();
  const fieldId = id ?? `${auto}-field`;
  const hintId = `${auto}-hint`;

  const reduced = useReducedMotion();
  const { ref, raised, focused, length, instant, fieldProps } = useFloatingLabel({
    value,
    defaultValue,
    disabled,
  });

  const move = reduced || instant ? INSTANT : LIFT;

  useImperativeHandle(inputRef, () => ref.current as HTMLInputElement, [ref]);

  const attach = useCallback(
    (node: HTMLInputElement | null) => {
      ref.current = node;
    },
    [ref],
  );

  const describedBy = [ariaDescribedBy, hint ? hintId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`w-full ${className}`}>
      <div className="relative pt-[20px]">
        <div
          className={`relative h-10 rounded-[10px] border-2 transition-[background-color,border-color,box-shadow] duration-150 ${
            invalid
              ? "border-destructive bg-background"
              : focused
                ? "border-primary bg-background"
                : "border-input bg-muted/70 shadow-[inset_0_1px_2px_rgb(0_0_0/0.08)]"
          } ${disabled ? "opacity-55" : ""}`}
        >
          <input
            ref={attach}
            id={fieldId}
            name={name}
            type={type}
            value={value}
            defaultValue={defaultValue}
            autoComplete={autoComplete}
            inputMode={inputMode}
            maxLength={maxLength}
            required={required}
            disabled={disabled}
            readOnly={readOnly}
            spellCheck={spellCheck}
            aria-required={required || undefined}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy || undefined}
            onFocus={() => {
              fieldProps.onFocus();
              onFocus?.();
            }}
            onBlur={() => {
              fieldProps.onBlur();
              onBlur?.();
            }}
            onChange={(event) => {
              fieldProps.onChange(event);
              onChange?.(event.currentTarget.value, event);
            }}
            className={`absolute inset-0 h-full w-full rounded-[9px] bg-transparent px-3 py-0 text-[13px] leading-[20px] text-foreground outline-none focus-visible:outline-none disabled:cursor-not-allowed ${
              endAdornment ? "pr-16" : ""
            }`}
          />
          {endAdornment ? (
            <div className="absolute inset-y-0 right-1.5 flex items-center">
              {endAdornment}
            </div>
          ) : null}
        </div>

        <motion.label
          htmlFor={fieldId}
          initial={false}
          animate={{
            y: raised ? RAISE : 0,
            x: raised ? SLIDE : 0,
            scale: raised ? SHRINK : 1,
          }}
          transition={move}
          style={{ originX: 0, originY: 0, willChange: "transform" }}
          className={`absolute left-3 top-[32px] block cursor-text select-none text-[13px] leading-[16px] ${
            invalid
              ? "text-destructive"
              : raised
                ? "text-foreground/80"
                : "text-muted-foreground"
          }`}
        >
          {label}
          {required ? (
            <span aria-hidden className="ml-0.5 text-muted-foreground">
              *
            </span>
          ) : null}
        </motion.label>
      </div>

      {reserveHintSpace || hint || maxLength !== undefined ? (
        <div className="mt-1.5 flex h-[16px] items-start gap-3">
          <p
            aria-hidden
            className={`min-w-0 flex-1 truncate text-[11.5px] leading-[16px] ${
              invalid ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {hint}
          </p>

          {maxLength !== undefined ? (
            <span
              aria-hidden
              className="grid shrink-0 justify-items-end font-mono text-[10.5px] leading-[16px] tabular-nums text-muted-foreground"
            >
              <span className="invisible col-start-1 row-start-1">
                {maxLength} / {maxLength}
              </span>
              <span className="col-start-1 row-start-1">
                {length} / {maxLength}
              </span>
            </span>
          ) : null}

          {hint ? (
            <span id={hintId} className="sr-only">
              {hint}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
