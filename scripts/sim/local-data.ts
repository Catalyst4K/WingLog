/**
 * Read-only access to the data a simulation replays: WingLog's own database and logs on this
 * machine (winglog-backend docs/plans/robustness/scenario-testing.md Part 6, "The method").
 * Nothing here writes to them, and what's read stays in `release/sim/` (gitignored): it's
 * personal data.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BeyondAtcInfoBox } from '../../src/shared/ipc'
import * as schema from '../../src/main/db/schema'
import type { WingLogDb } from '../../src/main/db/client'

/** WingLog's data folder: %APPDATA%\WingLog, or WINGLOG_SIM_DATA_DIR to use another copy. */
export function userDataDir(): string {
  const override = process.env.WINGLOG_SIM_DATA_DIR
  if (override) return resolve(override)
  const appData = process.env.APPDATA
  if (!appData)
    throw new Error(
      'APPDATA is not set: run the simulation on the machine WingLog flies on, or set WINGLOG_SIM_DATA_DIR'
    )
  return join(appData, 'WingLog')
}

/** The database, opened read-only: a simulation can never change a flight. */
export function openUserDb(dir: string = userDataDir()): { db: WingLogDb; close: () => void } {
  const sqlite = new Database(join(dir, 'winglog.db'), { readonly: true, fileMustExist: true })
  return { db: drizzle(sqlite, { schema }), close: () => sqlite.close() }
}

/** One set of InfoBoxes BeyondATC showed, as WingLog logged it. */
export interface LoggedInfoBoxes {
  /** Epoch ms. */
  atMs: number
  boxes: BeyondAtcInfoBox[]
}

/** `[2026-10-05 14:41:26.550] [info]  [beyondatc] InfoBoxes [...]`: electron-log's local time. */
const INFO_BOXES_LINE =
  /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{1,3})\] \[info\]\s+\[beyondatc\] InfoBoxes (.*)$/

/**
 * Every InfoBoxes set in a main.log's text, oldest first. Times are local, as electron-log writes
 * them, so this runs on the machine (and in the time zone) that wrote the log.
 */
export function parseInfoBoxesLog(text: string): LoggedInfoBoxes[] {
  const out: LoggedInfoBoxes[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = INFO_BOXES_LINE.exec(line)
    if (!match) continue
    const [, y, mo, d, h, mi, s, ms, json] = match
    let boxes: unknown
    try {
      boxes = JSON.parse(json)
    } catch {
      // A line cut short when the log rotated: nothing to read.
      continue
    }
    if (!Array.isArray(boxes)) continue
    const atMs = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
      Number(ms.padEnd(3, '0'))
    ).getTime()
    const valid = boxes.filter(
      (b): b is BeyondAtcInfoBox =>
        typeof b === 'object' && b !== null && typeof b.title === 'string' && typeof b.info === 'string'
    )
    out.push({ atMs, boxes: valid })
  }
  return out.sort((a, b) => a.atMs - b.atMs)
}

/** main.log and its rotated copy, parsed together. */
export function readInfoBoxesLogs(dir: string = userDataDir()): LoggedInfoBoxes[] {
  const texts = ['main.old.log', 'main.log']
    .map((name) => join(dir, 'logs', name))
    .filter(existsSync)
    .map((path) => readFileSync(path, 'utf8'))
  return parseInfoBoxesLog(texts.join('\n'))
}
