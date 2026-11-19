/**
 * Writes a file whole or not at all: to a temporary file beside it first, then renamed over it, so a crash or a full disk part-way leaves the
 * file that was there and never half of a new one. For files that cannot be rebuilt if they are lost, such as the encrypted keys.
 *
 * What is guaranteed: the temporary file's contents are flushed to the disk (`flush: true`, an fsync) before it is renamed, so after a power cut
 * the file at the path is the old one or the whole new one, never an empty or partial one. Not guaranteed: that the rename itself
 * reached the disk (the folder is not flushed), so after a power cut the old file may still be the one there, as if the write had
 * not happened.
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * @param path The file to write.
 * @param data What to put in it.
 * @throws When the temporary file cannot be written or moved into place (the file at `path` is then as it was).
 */
export function writeFileAtomically(path: string, data: string | Uint8Array): void {
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, data, { flush: true })
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The error being thrown is the one that matters, and a leftover temporary file is written over next time.
    }
    throw error
  }
}
