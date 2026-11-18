/**
 * Writes a file whole or not at all: to a temporary file beside it first, then renamed over it, so a crash or a full disk part-way leaves the
 * file that was there and never half of a new one. For files that cannot be rebuilt if they are lost, such as the encrypted keys.
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
    writeFileSync(temporary, data)
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
