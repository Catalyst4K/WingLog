/**
 * Named variations of a real capture, so one recording tests many cases nobody has flown
 * (winglog-backend docs/plans/robustness/scenario-testing.md Part 2). Each is pure: a capture
 * in, a new capture out, the base data left real. Each one comes from a real bug, and keeps
 * testing it.
 */
import type { SimTelemetry } from '../../src/shared/ipc'
import type {
  CapturedLineEvent,
  FlightFixtureEvent,
  ParsedFlightFixture
} from '../../src/main/sim/flight-fixture'

/** One variation. */
export type Transform = (capture: ParsedFlightFixture) => ParsedFlightFixture

/** A stretch of a capture, in ms from its start, inclusive. */
export interface Window {
  fromMs: number
  toMs: number
}

/** Height of the aircraft above the runway during a bounce, in metres. */
const BOUNCE_AGL_M = 1.5
/** Climb rate during a bounce, in m/s (~200 fpm). */
const BOUNCE_VS_MS = 1

/** Applies transforms in order. */
export function applyTransforms(base: ParsedFlightFixture, transforms: Transform[]): ParsedFlightFixture {
  return transforms.reduce((capture, transform) => transform(capture), base)
}

function sorted(events: FlightFixtureEvent[]): FlightFixtureEvent[] {
  return [...events].sort((a, b) => a.tOffsetMs - b.tOffsetMs)
}

function isIncomingAtc(event: FlightFixtureEvent): event is CapturedLineEvent {
  return event.type === 'beyondatc' && event.direction === 'in'
}

/** Rewrites the `info` of BeyondATC InfoBoxes whose title passes `titleTest`; other lines and
 *  malformed boxes are left as they are. */
function mapInfoBoxes(
  text: string,
  titleTest: (title: string) => boolean,
  map: (info: string) => string
): string {
  return text
    .split('\n')
    .map((line) => {
      const match = /^InfoBoxes:\s*(.*)$/.exec(line)
      if (!match) return line
      try {
        const boxes = JSON.parse(match[1]) as { title?: unknown; info?: unknown }[]
        if (!Array.isArray(boxes)) return line
        const mapped = boxes.map((box) =>
          typeof box.title === 'string' && typeof box.info === 'string' && titleTest(box.title.trim())
            ? { ...box, info: map(box.info) }
            : box
        )
        return `InfoBoxes: ${JSON.stringify(mapped)}`
      } catch {
        // Not JSON: BeyondATC's own malformed line, replayed unchanged.
        return line
      }
    })
    .join('\n')
}

/**
 * The aircraft taxis `factor` times faster through `window`: the same path, in fewer 1 Hz ticks
 * (every `factor`-th kept, at `factor` times the ground speed), and everything after it earlier
 * by the time saved. Covers a fast taxi along a parallel taxiway read as a takeoff roll (VHHH,
 * flight 230).
 */
export function speedUpTaxi(window: Window, factor: number): Transform {
  if (!Number.isInteger(factor) || factor < 1)
    throw new Error(`speedUpTaxi factor must be a whole number ≥ 1, not ${factor}`)
  return (capture) => {
    const inWindow = (e: FlightFixtureEvent): boolean =>
      e.tOffsetMs >= window.fromMs && e.tOffsetMs <= window.toMs
    const ticks = capture.events.filter((e) => e.type === 'telemetry' && inWindow(e))
    const kept = new Set(ticks.filter((_, i) => i % factor === 0))
    const savedMs = (window.toMs - window.fromMs) * (1 - 1 / factor)
    const events = capture.events.flatMap((e): FlightFixtureEvent[] => {
      if (e.tOffsetMs > window.toMs) return [{ ...e, tOffsetMs: e.tOffsetMs - savedMs }]
      if (!inWindow(e)) return [e]
      const tOffsetMs = window.fromMs + (e.tOffsetMs - window.fromMs) / factor
      if (e.type !== 'telemetry') return [{ ...e, tOffsetMs }]
      if (!kept.has(e)) return []
      return [{ ...e, tOffsetMs, data: { ...e.data, groundSpeedMs: e.data.groundSpeedMs * factor } }]
    })
    return { ...capture, events: sorted(events) }
  }
}

/** The tick index of the first touchdown after the aircraft has flown, or -1. */
function touchdownIndex(events: FlightFixtureEvent[]): number {
  let airborne = 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.type !== 'telemetry') continue
    if (!e.data.onGround) airborne++
    else if (airborne >= 3) return i
  }
  return -1
}

/**
 * The aircraft bounces after touchdown: `count` ticks just after the first touchdown are
 * airborne again, a metre and a half up and climbing. Covers being stuck in cruise after a
 * rollout bounce (flight 227, #108).
 *
 * @param afterTicks Ground ticks between touchdown and the bounce.
 */
export function bounceOnRollout(count: number, afterTicks = 1): Transform {
  return (capture) => {
    const start = touchdownIndex(capture.events)
    if (start < 0) throw new Error('bounceOnRollout: the capture has no touchdown')
    const bounce = new Set<FlightFixtureEvent>()
    let groundTicks = 0
    for (let i = start; i < capture.events.length && bounce.size < count; i++) {
      const e = capture.events[i]
      if (e.type !== 'telemetry') continue
      if (groundTicks < afterTicks) groundTicks++
      else bounce.add(e)
    }
    const airborne = (data: SimTelemetry): SimTelemetry => ({
      ...data,
      onGround: false,
      altitudeAglM: BOUNCE_AGL_M,
      altitudeM: data.altitudeM + BOUNCE_AGL_M,
      verticalSpeedMs: BOUNCE_VS_MS
    })
    return {
      ...capture,
      events: capture.events.map((e) =>
        e.type === 'telemetry' && bounce.has(e) ? { ...e, data: airborne(e.data) } : e
      )
    }
  }
}

/**
 * ATC clears a different runway: `from` becomes `to` wherever BeyondATC names a runway (the
 * InfoBoxes and the spoken lines). Covers the STAR clearance's runway being ignored (#109).
 * Matches whole runway idents only: "08" never touches "08L" or "1,080m".
 */
export function changeClearedRunway(from: string, to: string): Transform {
  const ident = new RegExp(`(?<![\\w,])${from}(?![\\w,])`, 'g')
  return (capture) => ({
    ...capture,
    events: capture.events.map((e) => (isIncomingAtc(e) ? { ...e, text: e.text.replace(ident, to) } : e))
  })
}

/**
 * Renames a taxiway in BeyondATC's taxi boxes (`Taxi Via n`, `Hold Position`) and spoken lines.
 * Covers multi-word taxiway names such as "LINK 36" (#111). The taxi network's own name is
 * renamed with renameTaxiwaySegments.
 */
export function renameTaxiway(from: string, to: string): Transform {
  const isTaxiBox = (title: string): boolean =>
    /^taxi via \d+$/i.test(title) || /^hold position$/i.test(title)
  const spoken = new RegExp(`(?<=\\b(?:via|on|onto|and|,)\\s+)${from}\\b`, 'g')
  return (capture) => ({
    ...capture,
    events: capture.events.map((e) => {
      if (!isIncomingAtc(e)) return e
      const boxes = mapInfoBoxes(e.text, isTaxiBox, (info) => (info.trim() === from ? to : info))
      return { ...e, text: boxes.replace(/^(ATC|Player):.*$/gm, (line) => line.replace(spoken, to)) }
    })
  })
}

/** The same rename in a cached taxi network (navdata segments with a `name`). */
export function renameTaxiwaySegments<T extends { name: string | null }>(
  segments: T[],
  from: string,
  to: string
): T[] {
  return segments.map((segment) => (segment.name === from ? { ...segment, name: to } : segment))
}

/**
 * ATC's spoken stand or gate line comes `seconds` later, while the boxes stay where they are.
 * Covers the gate offer waiting for speech (#112).
 */
export function delaySpokenStand(seconds: number): Transform {
  return (capture) => ({
    ...capture,
    events: sorted(
      capture.events.map((e) =>
        isIncomingAtc(e) && /^ATC:.*\b(?:gate|stand)\b/im.test(e.text)
          ? { ...e, tOffsetMs: e.tOffsetMs + seconds * 1000 }
          : e
      )
    )
  })
}

/** Removes every incoming BeyondATC message matching `match`: a missed transmission. */
export function dropAtcLine(match: RegExp): Transform {
  return (capture) => ({
    ...capture,
    events: capture.events.filter((e) => !(isIncomingAtc(e) && match.test(e.text)))
  })
}

/** Sends every incoming BeyondATC message matching `match` twice, `gapMs` apart: a repeat. */
export function duplicateAtcLine(match: RegExp, gapMs = 1000): Transform {
  return (capture) => ({
    ...capture,
    events: sorted(
      capture.events.flatMap((e) =>
        isIncomingAtc(e) && match.test(e.text) ? [e, { ...e, tOffsetMs: e.tOffsetMs + gapMs }] : [e]
      )
    )
  })
}

/**
 * Everything one stream sends arrives `seconds` later: BeyondATC or GSX connecting late, or a
 * slow sim. Covers load-order bugs (the map camera, a transcript read before a position).
 */
export function stallFieldUpdates(stream: CapturedLineEvent['type'], seconds: number): Transform {
  return (capture) => ({
    ...capture,
    events: sorted(
      capture.events.map((e) => (e.type === stream ? { ...e, tOffsetMs: e.tOffsetMs + seconds * 1000 } : e))
    )
  })
}
