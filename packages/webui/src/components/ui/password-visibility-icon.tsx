import { AnimatePresence, motion } from 'motion/react';
import { Eye, EyeOff } from 'lucide-react';

interface PasswordVisibilityIconProps {
  visible: boolean;
  reduceMotion?: boolean;
}

/** A stable-size password icon whose state change remains interruptible. */
export function PasswordVisibilityIcon({ visible, reduceMotion = false }: PasswordVisibilityIconProps) {
  const Icon = visible ? EyeOff : Eye;

  return (
    <span aria-hidden className="relative block size-4 overflow-hidden">
      <AnimatePresence initial={false}>
        <motion.span
          key={visible ? 'visible' : 'hidden'}
          className="absolute inset-0 flex items-center justify-center"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.15 }}
        >
          <Icon className="size-4" />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
