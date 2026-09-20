'use client';

import { motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * The mark, drawn inline rather than loaded as an image so its path can be
 * animated and its fill can inherit the colour of whatever it sits in.
 *
 * The shape is the platform's own: a node that branches into two, which is what
 * a policy check is. It arrived from QuiverAI (Arrow); the geometry is theirs,
 * the animation is ours.
 */
const MARK_PATH =
  'm38.82 21.42h5.07c1.51 0 2.64-1.22 2.64-2.7v-5.07c0-1.43-1.13-2.55-2.56-2.55h-5.17c-1.5 0-2.61 1.15-2.61 2.59v1.44c-1.57 0.01-3.04 0.75-4.05 2.01l-2.08 2.41c-0.13 0.13-0.25 0.25-0.35 0.33-0.5-0.37-1.1-0.54-1.77-0.54h-5.27c-1.56 0-2.63 1.26-2.63 2.8v1.37h-5.81v-1.55c0-1.52-1.17-2.62-2.7-2.62h-5.4c-1.56 0-2.63 1.19-2.63 2.7v5.54c0 1.55 1.08 2.68 2.63 2.68h5.4c1.57 0 2.72-1.23 2.72-2.76v-1.39h5.78v1.37c0 1.56 1.09 2.78 2.63 2.78h5.4c0.72 0 1.31-0.23 1.71-0.58 0.15 0.1 0.31 0.25 0.48 0.45l1.99 2.43c1 1.26 2.45 1.93 3.95 1.93v1.78c0 1.56 1.12 2.61 2.67 2.61h4.99c1.54 0 2.68-1.18 2.68-2.58v-5.24c0-1.54-1.11-2.54-2.64-2.54h-5.05c-1.55 0-2.64 1.17-2.64 2.61v0.92c-0.85 0.02-1.63-0.35-2.15-1.08l-1.96-2.39c-0.44-0.52-0.93-0.92-1.31-1.13v-5.39c0.43-0.25 0.9-0.64 1.35-1.18l1.91-2.26c0.55-0.68 1.35-1.02 2.15-1.01v1.14c0 1.51 1.13 2.67 2.63 2.67z';

export interface LogoMarkProps {
  size?: number;
  className?: string;
  /** Render without the entrance, for a mark that is already on screen. */
  still?: boolean;
}

export function LogoMark({ size = 24, className, still = false }: LogoMarkProps) {
  const reduced = useReducedMotion();
  const settled = still || reduced === true;

  return (
    <motion.svg
      viewBox="0 0 50 50"
      width={size}
      height={size}
      aria-hidden
      className={cn('shrink-0', className)}
      initial={settled ? false : { opacity: 0, scale: 0.6, rotate: -14 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      // Spread rather than pass `undefined`: the prop types reject an explicit
      // undefined under exactOptionalPropertyTypes.
      {...(settled ? {} : { whileHover: { scale: 1.07 } })}
      transition={{ type: 'spring', stiffness: 240, damping: 17 }}
    >
      <path d={MARK_PATH} fill="currentColor" />
    </motion.svg>
  );
}

/**
 * The mark as a backdrop. Kept faint enough to read as texture rather than as a
 * second thing to look at, and drifting slowly enough that it never pulls the
 * eye away from the numbers in front of it.
 */
export function BrandWatermark({ className }: { className?: string }) {
  const reduced = useReducedMotion();

  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <motion.div
        className="absolute -right-20 -bottom-28 text-[var(--color-primary)] opacity-[0.05]"
        {...(reduced === true ? {} : { animate: { y: [0, -22, 0], rotate: [0, 5, 0] } })}
        transition={{ duration: 28, repeat: Infinity, ease: 'easeInOut' }}
      >
        <LogoMark size={460} still />
      </motion.div>
    </div>
  );
}
