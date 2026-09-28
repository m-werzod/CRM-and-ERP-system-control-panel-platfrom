import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, resolving Tailwind conflicts so a caller's override wins.
 *
 * Without `twMerge`, `cn('px-3', 'px-6')` emits both and the winner depends on
 * stylesheet order rather than on intent — which is exactly the bug that makes a
 * component's `className` prop feel unreliable.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
