/** shadcn/ui's class-name helper. */

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Joins class names, the later one winning a Tailwind conflict.
 *
 * @param inputs Class names, conditionals and arrays.
 * @returns One class string, with Tailwind conflicts resolved.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
