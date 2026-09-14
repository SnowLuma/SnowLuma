import { AnimatePresence, motion } from 'motion/react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordVisibilityIconProps {
  visible: boolean;
  reduceMotion?: boolean;
}

const hidden = { opacity: 0, scale: 0.25, filter: 'blur(4px)' };
const shown = { opacity: 1, scale: 1, filter: 'blur(0px)' };

/** A stable-size password icon whose state change remains interruptible. */
export function PasswordVisibilityIcon({ visible, reduceMotion = false }: PasswordVisibilityIconProps) {
  const Icon = visible ? EyeOff : Eye;

  return (
    <span aria-hidden className="relative block size-4">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={visible ? 'visible' : 'hidden'}
          className="absolute inset-0 flex items-center justify-center"
          initial={reduceMotion ? false : hidden}
          animate={shown}
          exit={reduceMotion ? shown : hidden}
          transition={reduceMotion ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0 }}
        >
          <Icon className="size-4" />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
