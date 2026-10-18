/** The second-screen page's files: the built page in `out/lan/`, served from memory by path, nothing outside that folder. */

import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import type { StaticFile } from './LanServer'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

/**
 * @param folder The built page's folder.
 * @returns A lookup from a request path (`/`, `/assets/app.js`) to its file. Files are read once, here; a path not under the folder, or
 *   of a type not listed, is not found. A missing folder gives a lookup that finds nothing.
 */
export function staticFilesFrom(folder: string): (path: string) => StaticFile | null {
  const files = new Map<string, StaticFile>()
  const walk = (dir: string): void => {
    // The entry's own kind, not a second look at the path: nothing is checked and then read as if it were still the same file.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const type = TYPES[extname(entry.name).toLowerCase()]
      if (!type) continue
      const urlPath = '/' + relative(folder, full).split(sep).join('/')
      files.set(urlPath, { type, body: readFileSync(full) })
    }
  }
  try {
    walk(folder)
  } catch {
    return () => null
  }
  const index = files.get('/index.html')
  if (index) files.set('/', index)
  return (path) => files.get(path) ?? null
}
