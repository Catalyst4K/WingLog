/**
 * The dev build's full capture of each tracked flight: every sim telemetry tick, every
 * BeyondATC and GSX message in and out, one NDJSON file per flight, in the replay fixture
 * format (`src/main/sim/flight-fixture.ts`). Every test flight becomes data a scenario test can
 * replay (flightdeck-backend docs/plans/robustness/scenario-testing.md Part 1).
 *
 * Local only. Captures hold personal data (callsign, SimBrief pilot ID in OFP lines), so a
 * committed fixture is always a trimmed, anonymised slice, never a capture file.
 *
 * Retention (Callum, 2026-10-05): the newest KEEP_COUNT captures are kept; anything moved into
 * the `kept/` subfolder is never deleted.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import type { CaptureKeepState, SimTelemetry } from '@shared/ipc'
import type { FlightFixtureEvent, FlightFixtureHeader } from '../sim/flight-fixture'

/** Captures kept automatically, newest first; older ones are deleted when a new one starts. */
export const KEEP_COUNT = 50
/** Captures moved here are never deleted automatically. */
export const KEPT_DIR = 'kept'
/** Capture files' extension, so retention never touches anything else in the folder. */
const EXTENSION = '.ndjson'

/** Identifies a capture file as this format, for the replay to check. */
export const CAPTURE_FORMAT = 'winglog-capture-2'

export type { CaptureKeepState }

/** The prefix of every capture file for a flight. */
function capturePrefix(flightId: number): string {
  return `flight-${flightId}-`
}

function captureNames(dir: string, flightId: number): string[] {
  try {
    return readdirSync(dir).filter((name) => name.startsWith(capturePrefix(flightId)) && name.endsWith(EXTENSION))
  } catch {
    // No folder yet: no captures.
    return []
  }
}

export interface CaptureHeader extends FlightFixtureHeader {
  format: typeof CAPTURE_FORMAT
  flightId: number
}

/**
 * Deletes all but the newest `keep` capture files in `dir` (by modification time). Never looks
 * inside `kept/`.
 *
 * @returns The file names deleted.
 */
export function pruneCaptures(dir: string, keep: number): string[] {
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(EXTENSION))
  } catch {
    return []
  }
  const newestFirst = names
    .map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const deleted: string[] = []
  for (const { name } of newestFirst.slice(keep)) {
    try {
      unlinkSync(join(dir, name))
      deleted.push(name)
    } catch {
      // In use or already gone: tried again at the next capture.
    }
  }
  return deleted
}

/** Records one flight at a time; start() while one is open finishes that one first. */
export class FlightCapture {
  private stream: WriteStream | undefined
  private startMs = 0
  private path: string | undefined
  private flightId: number | undefined
  /** Move the open file into kept/ once it's closed (Windows can't rename an open file). */
  private keepOnStop = false

  /**
   * @param dir The captures folder (created if missing).
   * @param nowMs The clock, in epoch milliseconds; injected so tests control it.
   */
  constructor(
    private readonly dir: string,
    private readonly nowMs: () => number = Date.now,
    private readonly keepCount: number = KEEP_COUNT
  ) {}

  get isRecording(): boolean {
    return this.stream !== undefined
  }

  /** The file being written, or undefined when not recording. */
  get currentPath(): string | undefined {
    return this.path
  }

  /**
   * Opens a new capture file for a flight and writes its header line. Prunes old captures
   * first, so the new one always survives.
   *
   * @returns The new file's path.
   */
  start(flightId: number, aircraftType: string): string {
    this.stop()
    mkdirSync(this.dir, { recursive: true })
    pruneCaptures(this.dir, this.keepCount - 1)
    this.startMs = this.nowMs()
    const startedAt = new Date(this.startMs).toISOString()
    this.path = join(this.dir, `${capturePrefix(flightId)}${startedAt.replace(/[:.]/g, '-')}${EXTENSION}`)
    this.flightId = flightId
    this.stream = createWriteStream(this.path, { flags: 'a' })
    // A disk error stops the capture, never the app.
    this.stream.on('error', () => this.stop())
    const header: CaptureHeader = {
      format: CAPTURE_FORMAT,
      scenario: `flight-${flightId}`,
      flightId,
      aircraftType,
      capturedAt: startedAt,
      notes: 'WingLog dev build capture: sim, beyondatc and gsx streams. Personal data: never commit as is.'
    }
    this.stream.write(`${JSON.stringify(header)}\n`)
    return this.path
  }

  telemetry(data: SimTelemetry): void {
    this.write({ type: 'telemetry', tOffsetMs: this.offset(), data })
  }

  paused(value: boolean): void {
    this.write({ type: 'paused', tOffsetMs: this.offset(), value })
  }

  beyondAtc(direction: 'in' | 'out', text: string): void {
    this.write({ type: 'beyondatc', tOffsetMs: this.offset(), direction, text })
  }

  gsx(direction: 'in' | 'out', text: string): void {
    this.write({ type: 'gsx', tOffsetMs: this.offset(), direction, text })
  }

  /** Closes the current file, if any. Safe to call when not recording. */
  stop(): void {
    const { stream, path } = this
    if (stream && path && this.keepOnStop) stream.on('close', () => this.moveToKept(path))
    stream?.end()
    this.stream = undefined
    this.path = undefined
    this.flightId = undefined
    this.keepOnStop = false
  }

  /** Whether a flight has a capture, and whether it's kept for good. */
  keepState(flightId: number): CaptureKeepState {
    if (captureNames(join(this.dir, KEPT_DIR), flightId).length > 0) return 'kept'
    if (this.flightId === flightId && this.keepOnStop) return 'kept'
    return captureNames(this.dir, flightId).length > 0 ? 'auto' : 'none'
  }

  /**
   * Keeps a flight's captures for good by moving them into kept/. The file still being written
   * is moved when the flight ends.
   *
   * @returns The flight's state afterwards.
   */
  keep(flightId: number): CaptureKeepState {
    if (this.flightId === flightId) this.keepOnStop = true
    for (const name of captureNames(this.dir, flightId)) {
      const path = join(this.dir, name)
      if (path !== this.path) this.moveToKept(path)
    }
    return this.keepState(flightId)
  }

  private moveToKept(path: string): void {
    const keptDir = join(this.dir, KEPT_DIR)
    mkdirSync(keptDir, { recursive: true })
    const target = join(keptDir, path.slice(this.dir.length + 1))
    if (existsSync(path)) renameSync(path, target)
  }

  private offset(): number {
    return Math.max(0, this.nowMs() - this.startMs)
  }

  private write(event: FlightFixtureEvent): void {
    this.stream?.write(`${JSON.stringify(event)}\n`)
  }
}

/** A flight id from the renderer: a positive integer, so it can only name a capture file. */
export function isFlightId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}
