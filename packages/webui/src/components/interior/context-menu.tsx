"use client";

import { type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

const EASE = [0.23, 1, 0.32, 1] as const;
const EXIT = [0.4, 0, 1, 1] as const;

export type ContextMenuPlacement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  transformOrigin: string;
  visible?: boolean;
};

export type ContextMenuSurfaceProps = {
  openKey: number | string | null;
  menuRef: RefObject<HTMLDivElement | null>;
  placement: ContextMenuPlacement;
  label: string;
  children: ReactNode;
};

/**
 * Interior's context-menu surface, kept separate from action discovery so the
 * WebUI can build native browser-style actions from the element under pointer.
 */
export function ContextMenuSurface({
  openKey,
  menuRef,
  placement,
  label,
  children,
}: ContextMenuSurfaceProps) {
  const reduced = useReducedMotion();

  return createPortal(
    <AnimatePresence initial={false}>
      {openKey !== null ? (
        <motion.div
          key={openKey}
          ref={menuRef}
          role="menu"
          aria-label={label}
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={
            reduced
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, scale: 0.98, transition: { duration: 0.14, ease: EXIT } }
          }
          transition={reduced ? { duration: 0 } : { duration: 0.2, ease: EASE }}
          style={{
            position: "fixed",
            left: placement.left,
            top: placement.top,
            width: placement.width,
            maxHeight: placement.maxHeight,
            transformOrigin: placement.transformOrigin,
            visibility: placement.visible === false ? "hidden" : "visible",
            zIndex: 2147483646,
          }}
          className="global-context-menu"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
