/**
 * The dev build's diagnostic log: categorised lines in a separate rotating `diag.log`, so a
 * bug found on a test flight can be diagnosed from the log afterwards instead of reconstructed
 * (winglog-backend docs/plans/robustness/dev-build.md).
 *
 * Only the dev build writes it (`__WINGLOG_DEV_BUILD__`); in the normal build `createDiag(null)`
 * gives a function that does nothing. Local files only, nothing is sent anywhere.
 */
import { join } from 'node:path'
import log from 'electron-log/main'

/** What a diagnostic line is about; each line starts `[diag:<category>]` for filtering. */
export const DIAG_CATEGORIES = ['phase', 'atc', 'beyondatc', 'gsx', 'map', 'capture'] as const
export type DiagCategory = (typeof DIAG_CATEGORIES)[number]

/** Writes one diagnostic line, or does nothing outside the dev build. */
export type Diag = (category: DiagCategory, message: string, data?: unknown) => void

/** Longest line kept, in characters: a whole BeyondATC snapshot can be tens of kB. */
export const MAX_LINE_CHARS = 8_000
/** `diag.log` rotates to `diag.old.log` past this size, in bytes. */
const MAX_LOG_BYTES = 10 * 1024 * 1024

/**
 * @param value A category from the renderer.
 * @returns True if it is one of DIAG_CATEGORIES.
 */
export function isDiagCategory(value: unknown): value is DiagCategory {
  return typeof value === 'string' && (DIAG_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Formats one diagnostic line: the category, the message, and `data` as JSON if given.
 *
 * @param category The line's category.
 * @param message What happened.
 * @param data Anything JSON-serialisable. If it can't be serialised, the line says so rather
 *   than throwing: logging must never break the code it's watching.
 * @returns The line, cut to MAX_LINE_CHARS.
 */
export function formatDiagLine(category: DiagCategory, message: string, data?: unknown): string {
  let line = `[diag:${category}] ${message}`
  if (data !== undefined) {
    let json: string
    try {
      json = JSON.stringify(data) ?? String(data)
    } catch {
      json = '(unserialisable data)'
    }
    line += ` ${json}`
  }
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (cut)` : line
}

/**
 * Makes the diag function.
 *
 * @param write Where lines go, or null for a function that does nothing (the normal build).
 * @returns The diag function.
 */
export function createDiag(write: ((line: string) => void) | null): Diag {
  if (!write) return () => undefined
  return (category, message, data) => {
    try {
      write(formatDiagLine(category, message, data))
    } catch {
      // A failing log write is never allowed to break tracking or a service.
    }
  }
}

/**
 * The real writer: an electron-log instance of its own, writing `diag.log` beside `main.log`
 * (Windows: `%APPDATA%\WingLog\logs\diag.log`), never to the console.
 *
 * @returns A function that writes one line to diag.log.
 */
export function openDiagLog(): (line: string) => void {
  const diagLog = log.create({ logId: 'diag' })
  diagLog.transports.console.level = false
  diagLog.transports.file.level = 'info'
  diagLog.transports.file.maxSize = MAX_LOG_BYTES
  diagLog.transports.file.resolvePathFn = (variables) => join(variables.libraryDefaultDir, 'diag.log')
  return (line) => diagLog.info(line)
}
