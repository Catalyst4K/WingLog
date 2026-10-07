/**
 * Whether a path from outside the main process (the renderer, a file, a receipt) stays inside the
 * folder it should, once resolved: the check CLAUDE.md's Security section asks for before reading
 * or opening a path that didn't come from WingLog itself.
 */
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Checks that `path` resolves to somewhere inside `folder`, not the folder itself and not outside
 * it through `..` or another drive.
 *
 * @param folder The folder the path must stay in.
 * @param path The path to check, absolute or relative to the working directory.
 * @returns True when `path` is inside `folder`.
 */
export function isInsideFolder(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
