import * as React from 'react';
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
} from 'motion/react';
import { useTheme } from '@/contexts/ThemeContext';

const POINTER_MEDIA = '(hover: hover) and (pointer: fine)';
const MODE_PROPERTY = '--snowluma-cursor-mode';
const RESIZE_MODE_PROPERTY = '--snowluma-cursor-resize-mode';
const POINTER_SPRING = { stiffness: 1000, damping: 50 } as const;

const CURSOR_MODES = [
  'default',
  'target',
  'text',
  'grab',
  'grabbing',
  'move',
  'ew-resize',
  'ns-resize',
  'nwse-resize',
  'nesw-resize',
  'not-allowed',
  'wait',
  'crosshair',
  'copy',
  'zoom-in',
  'zoom-out',
  'help',
  'hidden',
] as const;

type CursorMode = (typeof CURSOR_MODES)[number];

interface CursorContext {
  mode: CursorMode;
  anchor: Element | null;
  tracksPointerRegion: boolean;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

function readCursorMode(element: Element): CursorMode {
  const value = getComputedStyle(element).getPropertyValue(MODE_PROPERTY).trim();
  return (CURSOR_MODES as readonly string[]).includes(value)
    ? value as CursorMode
    : 'default';
}

/**
 * CSS owns the semantic mapping. JavaScript only reads the resolved custom
 * property and finds the outermost element that still belongs to that mode.
 * This keeps nested SVGs/spans inside a button attached to the whole button.
 */
function resolveCursorContext(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): CursorContext {
  if (!(target instanceof Element)) {
    return { mode: 'default', anchor: null, tracksPointerRegion: false };
  }

  const styles = getComputedStyle(target);
  const resizeModeValue = styles.getPropertyValue(RESIZE_MODE_PROPERTY).trim();
  const resizeMode = (CURSOR_MODES as readonly string[]).includes(resizeModeValue)
    ? resizeModeValue as CursorMode
    : null;

  if (resizeMode) {
    const rect = target.getBoundingClientRect();
    const inResizeCorner = clientX >= rect.right - 18
      && clientX <= rect.right
      && clientY >= rect.bottom - 18
      && clientY <= rect.bottom;
    if (inResizeCorner) {
      return { mode: resizeMode, anchor: null, tracksPointerRegion: true };
    }
  }

  const modeValue = styles.getPropertyValue(MODE_PROPERTY).trim();
  const mode = (CURSOR_MODES as readonly string[]).includes(modeValue)
    ? modeValue as CursorMode
    : 'default';
  if (mode !== 'target') {
    return { mode, anchor: null, tracksPointerRegion: Boolean(resizeMode) };
  }

  let anchor = target;
  let parent = target.parentElement;
  while (parent && readCursorMode(parent) === mode) {
    anchor = parent;
    parent = parent.parentElement;
  }
  return { mode, anchor, tracksPointerRegion: Boolean(resizeMode) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Global adaptive cursor for fine-pointer desktop environments.
 *
 * All cursor semantics and visual variants live in index.css. The component
 * only tracks the pointer, reads the CSS-selected mode, and supplies target
 * geometry for Mikk Martin-style target morphing.
 */
export function AdaptivePointer() {
  const { appearance } = useTheme();
  const systemReducedMotion = useReducedMotion();
  const finePointer = useMediaQuery(POINTER_MEDIA);
  const enabled = appearance.customPointerSystem
    && finePointer
    && !appearance.reduceMotion
    && !appearance.disableMotion
    && !systemReducedMotion;

  const cursorRef = React.useRef<HTMLDivElement>(null);
  const rawX = useMotionValue(-100);
  const rawY = useMotionValue(-100);
  const x = useSpring(rawX, POINTER_SPRING);
  const y = useSpring(rawY, POINTER_SPRING);

  React.useEffect(() => {
    const cursor = cursorRef.current;
    if (!enabled || !cursor) return;

    const root = document.documentElement;
    const lastPoint = { x: -100, y: -100 };
    let context: CursorContext = { mode: 'default', anchor: null, tracksPointerRegion: false };
    let lastEventTarget: EventTarget | null = null;
    let targetObserver: ResizeObserver | null = null;

    root.dataset.cursorSystem = 'custom';
    cursor.dataset.visible = 'false';

    const stopObservingTarget = () => {
      targetObserver?.disconnect();
      targetObserver = null;
    };

    const setMode = (mode: CursorMode) => {
      cursor.dataset.mode = mode;
      if (mode !== 'target') {
        cursor.style.removeProperty('--cursor-target-width');
        cursor.style.removeProperty('--cursor-target-height');
        cursor.style.removeProperty('--cursor-target-radius');
      }
    };

    const positionTarget = () => {
      const anchor = context.anchor;
      if (context.mode !== 'target' || !anchor?.isConnected) return false;

      const rect = anchor.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;

      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const magneticX = clamp((lastPoint.x - centerX) / Math.max(rect.width / 2, 1), -1, 1) * 10;
      const magneticY = clamp((lastPoint.y - centerY) / Math.max(rect.height / 2, 1), -1, 1) * 10;
      const radius = getComputedStyle(anchor).borderRadius || '0.75rem';

      cursor.style.setProperty('--cursor-target-width', `${rect.width}px`);
      cursor.style.setProperty('--cursor-target-height', `${rect.height}px`);
      cursor.style.setProperty('--cursor-target-radius', radius);
      rawX.set(centerX + magneticX);
      rawY.set(centerY + magneticY);
      return true;
    };

    const observeTarget = (anchor: Element | null) => {
      stopObservingTarget();
      if (!anchor) return;
      targetObserver = new ResizeObserver(positionTarget);
      targetObserver.observe(anchor);
    };

    const applyContext = (next: CursorContext) => {
      const targetChanged = next.anchor !== context.anchor;
      context = next;
      setMode(next.mode);
      if (targetChanged) observeTarget(next.mode === 'target' ? next.anchor : null);
    };

    const positionAtPointer = () => {
      if (context.mode === 'target' && positionTarget()) return;
      rawX.set(lastPoint.x);
      rawY.set(lastPoint.y);
    };

    const refreshContext = (target: EventTarget | null) => {
      lastEventTarget = target;
      applyContext(resolveCursorContext(target, lastPoint.x, lastPoint.y));
      positionAtPointer();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      lastPoint.x = event.clientX;
      lastPoint.y = event.clientY;
      cursor.dataset.visible = 'true';
      if (event.target !== lastEventTarget || context.tracksPointerRegion) refreshContext(event.target);
      else positionAtPointer();
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      lastPoint.x = event.clientX;
      lastPoint.y = event.clientY;
      cursor.dataset.visible = 'true';
      refreshContext(event.target);
    };

    const onPointerOut = (event: PointerEvent) => {
      if (event.relatedTarget === null) cursor.dataset.visible = 'false';
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      cursor.dataset.pressed = 'true';
      refreshContext(event.target);
      if (context.mode === 'grab') setMode('grabbing');
    };

    const restorePointerContext = () => {
      cursor.dataset.pressed = 'false';
      const target = document.elementFromPoint(lastPoint.x, lastPoint.y);
      refreshContext(target);
    };

    const onDragStart = () => {
      cursor.dataset.pressed = 'true';
      setMode('grabbing');
    };

    const onViewportChange = () => positionTarget();
    const hide = () => { cursor.dataset.visible = 'false'; };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') hide();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerover', onPointerOver, { passive: true });
    window.addEventListener('pointerout', onPointerOut, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    window.addEventListener('pointerup', restorePointerContext, { capture: true, passive: true });
    window.addEventListener('pointercancel', restorePointerContext, { capture: true, passive: true });
    window.addEventListener('dragstart', onDragStart, { capture: true });
    window.addEventListener('dragend', restorePointerContext, { capture: true });
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopObservingTarget();
      delete root.dataset.cursorSystem;
      cursor.dataset.visible = 'false';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerover', onPointerOver);
      window.removeEventListener('pointerout', onPointerOut);
      window.removeEventListener('pointerdown', onPointerDown, { capture: true });
      window.removeEventListener('pointerup', restorePointerContext, { capture: true });
      window.removeEventListener('pointercancel', restorePointerContext, { capture: true });
      window.removeEventListener('dragstart', onDragStart, { capture: true });
      window.removeEventListener('dragend', restorePointerContext, { capture: true });
      window.removeEventListener('scroll', onViewportChange, { capture: true });
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, rawX, rawY]);

  return (
    <motion.div
      ref={cursorRef}
      className="adaptive-cursor"
      data-mode="default"
      data-visible="false"
      data-pressed="false"
      style={{ x, y }}
      aria-hidden="true"
    >
      <span className="adaptive-cursor-shape" />
    </motion.div>
  );
}
