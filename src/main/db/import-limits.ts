import { open } from 'node:fs/promises'

/** Import files are read whole into memory; anything bigger than this isn't a fleet/logbook
 *  export. The path comes from a native dialog, but the file's contents are still untrusted. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024

/** Reads an import file, refusing anything implausibly large. The size check and the read
 *  go through one open handle (fstat, not a separate stat-then-read by path), so the file
 *  can't be swapped for a bigger one between the two. */
export async function readImportFile(path: string, tooLargeMessage: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    if ((await handle.stat()).size > MAX_IMPORT_BYTES) throw new Error(tooLargeMessage)
    return await handle.readFile('utf-8')
  } finally {
    await handle.close()
  }
}
