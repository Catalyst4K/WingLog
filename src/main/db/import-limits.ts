/**
 * The size limit on fleet and logbook import files, and the read that enforces it.
 */
import { open } from 'node:fs/promises'

/** Import files are read whole into memory; anything bigger than this isn't a fleet/logbook
 *  export. The path comes from a native dialog, but the file's contents are still untrusted. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024

/** Reads a file the pilot chose, refusing anything over a limit. The size check and the read
 *  go through one open handle (fstat, not a separate stat-then-read by path), so the file
 *  can't be swapped for a bigger one between the two.
 *
 * @param path The file the pilot chose.
 * @param maxBytes The largest file to accept, in bytes.
 * @param tooLargeMessage The error to show when it's over the limit.
 * @returns The file's bytes.
 * @throws When it's too large or can't be read.
 */
export async function readLimitedFile(
  path: string,
  maxBytes: number,
  tooLargeMessage: string
): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    if ((await handle.stat()).size > maxBytes) throw new Error(tooLargeMessage)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** Reads an import file, refusing anything implausibly large.
 *
 * @param path The file the pilot chose.
 * @param tooLargeMessage The error to show when it's over the limit.
 * @returns The file's text.
 * @throws When it's too large or can't be read.
 */
export async function readImportFile(path: string, tooLargeMessage: string): Promise<string> {
  return (await readLimitedFile(path, MAX_IMPORT_BYTES, tooLargeMessage)).toString('utf-8')
}
