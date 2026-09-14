import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

type RootProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>;
type ObscuredRanges = [[number, number], [number, number]];

export interface SliderProps extends Omit<
  RootProps,
  'children' | 'defaultValue' | 'min' | 'max' | 'orientation' | 'step' | 'value' | 'onValueChange'
> {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  valueLabelFormat?: (value: number) => React.ReactNode;
  onValueChange?: (value: number) => void;
}

const POSITION_SPRING = { type: 'spring', stiffness: 2000, damping: 40, mass: 0.01 } as const;
const STRETCH_SPRING = { stiffness: 2000, damping: 40, mass: 1 } as const;
const VISIBILITY_SPRING = { stiffness: 1000, damping: 20, mass: 0.01 } as const;
const HANDLE_WIDTH = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mapRange(
  value: number,
  inputMin: number,
  inputMax: number,
  outputMin: number,
  outputMax: number,
  shouldClamp = true,
): number {
  if (inputMin === inputMax) return outputMin;
  const progress = (value - inputMin) / (inputMax - inputMin);
  const mapped = outputMin + (outputMax - outputMin) * progress;
  return shouldClamp ? clamp(mapped, Math.min(outputMin, outputMax), Math.max(outputMin, outputMax)) : mapped;
}

function snapValue(value: number, min: number, max: number, step: number): number {
  const snapped = min + Math.round((value - min) / step) * step;
  return clamp(Number(snapped.toFixed(12)), min, max);
}

function circleEase(value: number): number {
  return Math.sqrt(Math.max(0, 1 - (value - 1) ** 2));
}

function SliderTick({
  springX,
  percentage,
  position,
  last,
  obscuredRanges,
}: {
  springX: MotionValue<number>;
  percentage: number;
  position: string;
  last: boolean;
  obscuredRanges: React.RefObject<ObscuredRanges>;
}) {
  const opacity = useTransform(springX, (current) => {
    const coveredByText = obscuredRanges.current.some(([start, end]) => start <= percentage && end >= percentage);
    if (last || coveredByText) return 0;
    return Number(current + 8 <= percentage || current - 8 > percentage);
  });
  const transition = useTransform(springX, (current) => (
    current + 8 <= percentage || current - 8 > percentage ? 'opacity 0.1s' : 'opacity 0s'
  ));

  return (
    <motion.span
      className="slider-tick"
      style={{ left: position, opacity, transition }}
    />
  );
}

function SliderTicks({
  springX,
  min,
  max,
  step,
  obscuredRanges,
}: {
  springX: MotionValue<number>;
  min: number;
  max: number;
  step: number;
  obscuredRanges: React.RefObject<ObscuredRanges>;
}) {
  const rawIntervals = (max - min) / step;
  const intervals = Math.round(rawIntervals);
  if (Math.abs(rawIntervals - intervals) > 1e-6 || intervals <= 1 || intervals > 16) return null;

  return (
    <motion.div
      className="slider-ticks"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {Array.from({ length: intervals }, (_, index) => {
        const ratio = (index + 1) / intervals;
        const percentage = ratio * 100;
        const compensation = percentage < 50
          ? ratio * HANDLE_WIDTH - HANDLE_WIDTH / 2
          : -ratio * HANDLE_WIDTH + HANDLE_WIDTH / 2;

        return (
          <SliderTick
            key={index}
            springX={springX}
            percentage={percentage}
            position={`calc(${percentage}% + ${compensation}px)`}
            last={index === intervals - 1}
            obscuredRanges={obscuredRanges}
          />
        );
      })}
    </motion.div>
  );
}

/**
 * SnowLuma's themed integration of Mikk Martin's slider interaction model.
 * The Radix thumb owns keyboard, pointer and assistive-technology semantics;
 * the remaining layers reproduce the original visual and spring behavior.
 *
 * Reference: https://mikkmartin.co/repo/slider
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  label,
  valueLabelFormat,
  onValueChange,
  className,
  style,
  disabled,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  'aria-label': ariaLabel,
  'aria-valuetext': ariaValueText,
  'aria-describedby': ariaDescribedBy,
  ...props
}: SliderProps) {
  const { appearance } = useTheme();
  const systemReducedMotion = useReducedMotion();
  const reduceMotion = Boolean(appearance.reduceMotion || appearance.disableMotion || systemReducedMotion);
  const initialValue = snapValue(value, min, max, step);
  const [currentValue, setCurrentValue] = React.useState(initialValue);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const labelRef = React.useRef<HTMLSpanElement>(null);
  const valueLabelRef = React.useRef<HTMLSpanElement>(null);
  const draggingRef = React.useRef(false);
  const obscuredRanges = React.useRef<ObscuredRanges>([[0, 0], [0, 0]]);

  const valueMotion = useMotionValue(currentValue);
  const pointerProgress = useMotionValue(0);
  const pointerPercent = useTransform(pointerProgress, [0, 1], [0, 100], { clamp: false });
  const valuePercent = useTransform(valueMotion, [min, max], [0, 100], { clamp: false });
  const blendedPercent = useTransform(pointerPercent, (pointer) => (
    draggingRef.current ? (pointer + 2 * valuePercent.get()) / 3 : valuePercent.get()
  ));
  const springX = useSpring(blendedPercent, POSITION_SPRING);

  const stretch = useSpring(1, STRETCH_SPRING);
  const inverseStretch = useTransform(stretch, (scale) => 2 - scale);
  const transformOrigin = useMotionValue<'left' | 'right'>('left');
  const shiftX = useTransform(stretch, (scale) => (
    (1 - scale) * (transformOrigin.get() === 'right' ? 100 : -100)
  ));

  const handleCompensation = useTransform(springX, (percentage) => (
    percentage <= 50
      ? HANDLE_WIDTH * percentage / 100
      : HANDLE_WIDTH * (100 - percentage) / 100
  ));
  const fillWidth = useMotionTemplate`calc(${springX}% + ${handleCompensation}px)`;

  const handleVisibility = useSpring(1, VISIBILITY_SPRING);
  const handleHeight = useTransform(handleVisibility, [0, 1], [32, 24]);

  const formattedValue = valueLabelFormat ? valueLabelFormat(currentValue) : currentValue;

  React.useLayoutEffect(() => {
    const snapped = snapValue(value, min, max, step);
    valueMotion.set(snapped);
    if (snapped !== currentValue) setCurrentValue(snapped);
    const nextPercentage = mapRange(snapped, min, max, 0, 100);
    if (reduceMotion) springX.jump(nextPercentage);
    else blendedPercent.set(nextPercentage);
  }, [blendedPercent, currentValue, max, min, reduceMotion, springX, step, value, valueMotion]);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const labelNode = labelRef.current;
    const valueNode = valueLabelRef.current;
    if (!root || !labelNode || !valueNode) return;

    const update = () => {
      const width = root.offsetWidth;
      if (width <= 0) return;
      const toPercentage = (pixels: number) => pixels / width * 100;
      obscuredRanges.current = [
        [toPercentage(labelNode.offsetLeft), toPercentage(labelNode.offsetLeft + labelNode.offsetWidth)],
        [toPercentage(valueNode.offsetLeft), toPercentage(valueNode.offsetLeft + valueNode.offsetWidth)],
      ];
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    observer.observe(labelNode);
    observer.observe(valueNode);
    return () => observer.disconnect();
  }, [formattedValue, label]);

  useMotionValueEvent(blendedPercent, 'change', (latest) => {
    if (reduceMotion) springX.jump(latest);
  });

  useMotionValueEvent(springX, 'change', (percentage) => {
    const root = rootRef.current;
    if (!root) return;
    const toPercentage = (pixels: number) => pixels / root.offsetWidth * 100;
    const handleHalf = toPercentage(12);
    const padding = toPercentage(4);
    const [labelRange, valueRange] = obscuredRanges.current;
    const hidden = (
      (percentage > labelRange[0] - padding + handleHalf && percentage < labelRange[1] + handleHalf + padding)
      || (percentage > valueRange[0] - padding + handleHalf && percentage < 99)
    );
    if (reduceMotion) handleVisibility.jump(hidden ? 0 : 1);
    else handleVisibility.set(hidden ? 0 : 1);
  });

  const release = React.useCallback(() => {
    pointerProgress.set(valuePercent.get() / 100);
    draggingRef.current = false;
    if (reduceMotion) stretch.jump(1);
    else stretch.set(1);
  }, [pointerProgress, reduceMotion, stretch, valuePercent]);

  React.useEffect(() => {
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [release]);

  const updatePointer = React.useCallback((clientX: number) => {
    const root = rootRef.current;
    if (!root) return;
    const { left, width } = root.getBoundingClientRect();
    if (width <= 0) return;

    const normalized = (clientX - left) / width;
    pointerProgress.set(clamp(normalized, 0, 1));

    if (reduceMotion) return;
    if (normalized < 0) {
      transformOrigin.set('right');
      const eased = circleEase(mapRange(normalized, 0, -3, 0, 1));
      stretch.jump(mapRange(eased, 0, 1, 1, 1.02));
    } else if (normalized > 1) {
      transformOrigin.set('left');
      const eased = circleEase(mapRange(normalized, 1, 3, 0, 1));
      stretch.jump(mapRange(eased, 0, 1, 1, 1.02));
    }
  }, [pointerProgress, reduceMotion, stretch, transformOrigin]);

  return (
    <motion.div
      ref={rootRef}
      className={cn('slider-root group/slider', className)}
      data-disabled={disabled ? '' : undefined}
      style={{ ...style, x: shiftX, scaleX: stretch, scaleY: inverseStretch, transformOrigin }}
      onPointerDown={(event) => {
        draggingRef.current = true;
        updatePointer(event.clientX);
        onPointerDown?.(event);
      }}
      onPointerMove={(event) => {
        if (draggingRef.current) updatePointer(event.clientX);
        onPointerMove?.(event);
      }}
      onPointerUp={(event) => {
        release();
        onPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        release();
        onPointerCancel?.(event);
      }}
    >
      <SliderPrimitive.Root
        {...props}
        className="slider-radix-root"
        min={min}
        max={max}
        step={step}
        value={[currentValue]}
        disabled={disabled}
        onValueChange={([nextValue]) => {
          setCurrentValue(nextValue);
          valueMotion.set(nextValue);
          blendedPercent.jump(mapRange(nextValue, min, max, 0, 100));
          onValueChange?.(nextValue);
        }}
      >
        <SliderPrimitive.Thumb
          className="slider-native-thumb"
          aria-label={ariaLabel ?? label}
          aria-valuetext={ariaValueText}
          aria-describedby={ariaDescribedBy}
        />
      </SliderPrimitive.Root>

      <motion.div className="slider-active-range" style={{ width: fillWidth }} aria-hidden>
        <span className="slider-handle-slot">
          <motion.span
            className="slider-handle-line"
            style={{ opacity: handleVisibility, height: handleHeight }}
          />
        </span>
      </motion.div>

      <SliderTicks
        springX={springX}
        min={min}
        max={max}
        step={step}
        obscuredRanges={obscuredRanges}
      />

      <div className="slider-labels" aria-hidden>
        <span ref={labelRef}>{label}</span>
        <span ref={valueLabelRef} className="slider-value-label">{formattedValue}</span>
      </div>
    </motion.div>
  );
}
