/** The second-screen page's files: the built page in `out/lan/`, served from memory by path, nothing outside that folder. */

import { readFileSync, readdirSync, statSync } from 'node:fs'
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
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const type = TYPES[extname(name).toLowerCase()]
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
