/**
 * Reads a small text file that may not be there, without a check-then-read gap: the file is opened once, and its size is read from the open
 * file, so what is measured is what is read (CodeQL's js/file-system-race: a file checked by its path can be replaced before it is read).
 */
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'

/**
 * @param path The file.
 * @param maxBytes The most it may hold.
 * @returns Its text, or null when it is missing, is longer than `maxBytes`, or cannot be read.
 */
export function readTextUpTo(path: string, maxBytes: number): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    if (fstatSync(fd).size > maxBytes) return null
    return readFileSync(fd, 'utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
