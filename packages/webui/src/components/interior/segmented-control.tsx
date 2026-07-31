"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";

const CELL = { type: "spring", stiffness: 520, damping: 34, mass: 0.45 } as const;
const SEG =
  "px-3 py-[7px] text-center text-[13px] font-medium leading-[18px] tracking-[-0.01em] whitespace-nowrap";

export type SegmentedOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type SegmentedControlProps = {
  options: SegmentedOption[];
  label: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
};

export function SegmentedControl({
  options,
  label,
  value,
  defaultValue,
  onValueChange,
  className = "",
}: SegmentedControlProps) {
  const count = Math.max(1, options.length);
  const template = `repeat(${count}, minmax(0, 1fr))`;

  const [internal, setInternal] = useState(
    () => defaultValue ?? options[0]?.value ?? "",
  );
  const [hovered, setHovered] = useState(-1);

  const controlled = value !== undefined;
  const current = controlled ? value : internal;
  const found = options.findIndex((option) => option.value === current);
  const index = found < 0 ? 0 : found;

  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const emit = useRef(onValueChange);
  useEffect(() => {
    emit.current = onValueChange;
  }, [onValueChange]);

  const reduced = useReducedMotion();
  const pos = useMotionValue(index);
  const thumbX = useTransform(pos, (next) => `${next * 100}%`);
  const maskX = useTransform(pos, (next) => `${next * -100}%`);

  useEffect(() => {
    if (reduced) {
      pos.set(index);
      return;
    }
    const controls = animate(pos, index, CELL);
    return () => controls.stop();
  }, [index, reduced, pos]);

  const select = useCallback(
    (next: string) => {
      if (!controlled) setInternal(next);
      if (next !== current) emit.current?.(next);
    },
    [controlled, current],
  );

  const seek = useCallback(
    (from: number, direction: number) => {
      let next = from;
      for (let offset = 0; offset < count; offset += 1) {
        next = (next + direction + count) % count;
        if (!options[next]?.disabled) return next;
      }
      return from;
    },
    [count, options],
  );

  const go = useCallback(
    (next: number) => {
      const option = options[next];
      if (!option || option.disabled) return;
      buttons.current[next]?.focus();
      select(option.value);
    },
    [options, select],
  );

  const onKeyDown = (event: React.KeyboardEvent, optionIndex: number) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      go(seek(optionIndex, 1));
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      go(seek(optionIndex, -1));
    } else if (event.key === "Home") {
      event.preventDefault();
      go(seek(count - 1, 1));
    } else if (event.key === "End") {
      event.preventDefault();
      go(seek(0, -1));
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`relative inline-block select-none rounded-[9px] border border-border bg-muted/70 p-[3px] shadow-[inset_0_1px_2px_rgb(0_0_0/0.07)] ${className}`}
    >
      <div
        className="relative grid"
        style={{ gridTemplateColumns: template, touchAction: "manipulation" }}
      >
        {options.map((option, optionIndex) => (
          <span
            key={option.value}
            aria-hidden
            className={`${SEG} pointer-events-none ${
              option.disabled
                ? "text-muted-foreground/40"
                : hovered === optionIndex && optionIndex !== index
                  ? "text-foreground"
                  : "text-muted-foreground"
            }`}
          >
            {option.label}
          </span>
        ))}

        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden rounded-[6px] bg-foreground text-background shadow-[0_1px_2px_rgb(0_0_0/0.28)]"
          style={{ width: `${100 / count}%`, x: thumbX }}
          initial={false}
        >
          <motion.div
            className="absolute inset-0"
            style={{ x: maskX }}
            initial={false}
          >
            <div
              className="absolute inset-y-0 left-0 grid"
              style={{ width: `${count * 100}%`, gridTemplateColumns: template }}
            >
              {options.map((option) => (
                <span key={option.value} className={`${SEG} text-background`}>
                  {option.label}
                </span>
              ))}
            </div>
          </motion.div>
        </motion.div>
        <div
          className="absolute inset-0 grid"
          style={{ gridTemplateColumns: template }}
          onPointerLeave={() => setHovered(-1)}
        >
          {options.map((option, optionIndex) => (
            <button
              key={option.value}
              ref={(node) => {
                buttons.current[optionIndex] = node;
              }}
              type="button"
              role="radio"
              aria-checked={optionIndex === index}
              aria-disabled={option.disabled || undefined}
              tabIndex={optionIndex === index ? 0 : -1}
              onClick={() => !option.disabled && select(option.value)}
              onKeyDown={(event) => onKeyDown(event, optionIndex)}
              onPointerEnter={() => !option.disabled && setHovered(optionIndex)}
              className="cursor-default rounded-[6px] outline-none focus-visible:bg-primary/[0.06] focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
            >
              <span className="sr-only">{option.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
