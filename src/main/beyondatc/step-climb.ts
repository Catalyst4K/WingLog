import { EventEmitter } from 'node:events'
import type { ActiveTracking, BeyondAtcConnectionStatus, BeyondAtcStepClimbStatus, BeyondAtcTranscriptEntry, SimTelemetry } from '@shared/ipc'
import { parseOfp } from '../simbrief/simbrief-client'
import { requestAltitude, type AltitudeRequestSession } from './altitude-request'

/**
 * BeyondATC auto step climb (flightdeck-backend's docs/plans/beyondatc-auto-step-climb.md).
 * BeyondATC only changes the cleared level when the pilot asks; an aircraft left to fly its
 * own step climbs overnight drifts out of step with it. While switched on, this asks for each
 * new level itself. Callum's decisions, 2026-10-01:
 *
 * - **Two triggers.** SimBrief's planned steps say *where* (asked for under a minute before
 *   the step point); the FCU says *when* — an aircraft's own auto step climb changes the
 *   selected altitude the moment it starts the step.
 * - **Climbs only.**
 * - **Retry once**, then drop that level and move on.
 */

const FEET_PER_METRE = 1 / 0.3048
/** "Under a minute from the step" — measured as distance at the current ground speed. */
const SIMBRIEF_LEAD_S = 60
/** Floor for the lead distance, so a slow-moving test (or a ground-speed glitch) still fires. */
const MIN_LEAD_NM = 2
/** A knob sweep passes every value on the way (seen live on the Fenix) — only act once the
 *  selected altitude has sat still this long. */
const FCU_SETTLE_MS = 10_000
/** Anything this close to the cleared level is noise or the same level, not a step. */
const STEP_THRESHOLD_FT = 500
const RETRY_AFTER_MS = 120_000
const MAX_ATTEMPTS = 2

export interface StepTarget {
  ident: string
  lat: number
  lon: number
  altitudeFt: number
}

/** The OFP's planned step climbs, placed on the map via their navlog fix — `parseOfp` gives
 *  the levels (metric-aware), the raw navlog gives each fix's `pos_lat`/`pos_long`. A step
 *  whose fix isn't in the navlog is skipped (the FCU trigger still covers it). */
export function extractStepTargets(ofpJson: string | null): StepTarget[] {
  if (!ofpJson) return []
  try {
    const raw = JSON.parse(ofpJson) as { navlog?: { fix?: Record<string, unknown>[] } }
    const fixes = Array.isArray(raw.navlog?.fix) ? raw.navlog.fix : []
    return parseOfp(raw).stepClimbs.flatMap((step) => {
      const fix = fixes.find((f) => f.ident === step.atIdent)
      const lat = Number(fix?.pos_lat)
      const lon = Number(fix?.pos_long)
      return fix && Number.isFinite(lat) && Number.isFinite(lon)
        ? [{ ident: step.atIdent, lat, lon, altitudeFt: step.toAltitudeFt }]
        : []
    })
  } catch {
    return []
  }
}

// ATC's latest altitude instruction is the current clearance: "climb FL190", "climb via SID to
// FL140", "descend to 3,000m", "roger, new cruise altitude FL360" — all real phrasings.
const CLEARED_LEVEL =
  /(?:new cruise altitude|climb(?: via SID)?(?: and maintain)?(?: to)?|descend(?: and maintain)?(?: to)?) (FL ?\d{2,3}|[\d,]+ ?(?:m|meters|metres|feet|ft))\b/i

function levelToFeet(level: string): number | null {
  const fl = /^FL ?(\d{2,3})$/i.exec(level)
  if (fl) return Number(fl[1]) * 100
  const value = Number(/^[\d,]+/.exec(level)?.[0].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  return /(?:feet|ft)$/i.test(level) ? value : value * FEET_PER_METRE
}

export function clearedLevelFromTranscript(transcript: BeyondAtcTranscriptEntry[]): number | null {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i]!
    if (entry.speaker !== 'atc') continue
    const match = CLEARED_LEVEL.exec(entry.text)
    if (match) return levelToFeet(match[1]!)
  }
  return null
}

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number): number => (d * Math.PI) / 180
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2
  return 2 * 3440.065 * Math.asin(Math.sqrt(a))
}

export interface StepClimbDeps {
  getSession: () => (AltitudeRequestSession & { getStatus(): BeyondAtcConnectionStatus }) | undefined
  getActive: () => ActiveTracking | undefined
  getOfpJson: (flightId: number) => string | null
  request?: typeof requestAltitude
  now?: () => number
}

interface Attempt {
  count: number
  lastAt: number
}

export class StepClimbController extends EventEmitter<{ status: [BeyondAtcStepClimbStatus] }> {
  private enabled = false
  private flightId: number | null = null
  private steps: StepTarget[] = []
  private readonly attempts = new Map<number, Attempt>()
  private readonly dropped = new Set<number>()
  private inFlight: number | null = null
  private fcu: { valueFt: number; since: number } | null = null
  private last: BeyondAtcStepClimbStatus['last'] = null
  private nextStep: BeyondAtcStepClimbStatus['nextStep'] = null
  private lastEmitted = ''
  private readonly request: typeof requestAltitude
  private readonly now: () => number

  constructor(private readonly deps: StepClimbDeps) {
    super()
    this.request = deps.request ?? requestAltitude
    this.now = deps.now ?? Date.now
  }

  getStatus(): BeyondAtcStepClimbStatus {
    return {
      enabled: this.enabled,
      nextStep: this.nextStep,
      pendingAltitudeFt: this.inFlight,
      last: this.last
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.nextStep = null
      this.fcu = null
    }
    this.emitStatus()
  }

  onTelemetry(t: SimTelemetry): void {
    if (!this.enabled) return
    const now = this.now()

    const active = this.deps.getActive()
    if (!active) {
      this.flightId = null
      this.nextStep = null
      this.emitStatus()
      return
    }
    if (active.flightId !== this.flightId) {
      this.flightId = active.flightId
      this.steps = extractStepTargets(this.deps.getOfpJson(active.flightId))
      this.attempts.clear()
      this.dropped.clear()
      this.last = null
    }

    if (typeof t.apSelectedAltitudeM === 'number') {
      const selectedFt = t.apSelectedAltitudeM * FEET_PER_METRE
      if (!this.fcu || Math.abs(selectedFt - this.fcu.valueFt) > 50) this.fcu = { valueFt: selectedFt, since: now }
    }

    const session = this.deps.getSession()
    const clearedFt =
      (session ? clearedLevelFromTranscript(session.getTranscript()) : null) ??
      Math.round((t.pressureAltitudeM * FEET_PER_METRE) / 1000) * 1000

    const upcoming = this.steps.find((s) => s.altitudeFt > clearedFt + STEP_THRESHOLD_FT && !this.dropped.has(roundLevel(s.altitudeFt)))
    const upcomingDistance = upcoming ? distanceNm(t.latitude, t.longitude, upcoming.lat, upcoming.lon) : null
    this.nextStep =
      upcoming && upcomingDistance !== null
        ? { ident: upcoming.ident, altitudeFt: upcoming.altitudeFt, distanceNm: Math.round(upcomingDistance) }
        : null

    if (this.inFlight === null && active.phase === 'cruise' && session?.getStatus().state === 'connected') {
      const target = this.pickTarget(t, now, clearedFt, upcoming, upcomingDistance)
      if (target) this.fire(session, target.altitudeFt, target.reason, now)
    }
    this.emitStatus()
  }

  private pickTarget(
    t: SimTelemetry,
    now: number,
    clearedFt: number,
    upcoming: StepTarget | undefined,
    upcomingDistance: number | null
  ): { altitudeFt: number; reason: 'simbrief' | 'fcu' } | null {
    const leadNm = Math.max(MIN_LEAD_NM, ((t.groundSpeedMs * 3600) / 1852) * (SIMBRIEF_LEAD_S / 3600))
    const candidates: { altitudeFt: number; reason: 'simbrief' | 'fcu' }[] = []
    if (upcoming && upcomingDistance !== null && upcomingDistance <= leadNm) {
      candidates.push({ altitudeFt: upcoming.altitudeFt, reason: 'simbrief' })
    }
    if (this.fcu && now - this.fcu.since >= FCU_SETTLE_MS && this.fcu.valueFt > clearedFt + STEP_THRESHOLD_FT) {
      candidates.push({ altitudeFt: roundLevel(this.fcu.valueFt), reason: 'fcu' })
    }
    return (
      candidates.find((c) => {
        const key = roundLevel(c.altitudeFt)
        if (this.dropped.has(key)) return false
        const attempt = this.attempts.get(key)
        return !attempt || now - attempt.lastAt >= RETRY_AFTER_MS
      }) ?? null
    )
  }

  private fire(session: AltitudeRequestSession, altitudeFt: number, reason: 'simbrief' | 'fcu', now: number): void {
    const key = roundLevel(altitudeFt)
    const attempt = { count: (this.attempts.get(key)?.count ?? 0) + 1, lastAt: now }
    this.attempts.set(key, attempt)
    this.inFlight = key
    this.emitStatus()
    void this.request(session, altitudeFt)
      .then(({ outcome }) => {
        if (outcome === 'granted') this.attempts.delete(key)
        else if (attempt.count >= MAX_ATTEMPTS) this.dropped.add(key)
        this.last = { altitudeFt: key, outcome, attempt: attempt.count, reason, dropped: this.dropped.has(key) }
      })
      .finally(() => {
        this.inFlight = null
        this.emitStatus()
      })
  }

  private emitStatus(): void {
    const status = this.getStatus()
    const serialised = JSON.stringify(status)
    if (serialised === this.lastEmitted) return
    this.lastEmitted = serialised
    this.emit('status', status)
  }
}

/** Levels compared at 100 ft resolution, so FL390 from SimBrief and 39,000 from the FCU are
 *  the same step (and a metric level's odd feet value still has one key). */
function roundLevel(feet: number): number {
  return Math.round(feet / 100) * 100
}
