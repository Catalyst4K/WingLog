/**
 * Requests the SimBrief plan's step climbs from BeyondATC when they come up in cruise (and a
 * level set on the FCU), so the pilot doesn't have to ask each time.
 */
import { EventEmitter } from 'node:events'
import type { ActiveTracking, BeyondAtcConnectionStatus, BeyondAtcStepClimbStatus, SimTelemetry } from '@shared/ipc'
import { parseOfp } from '@shared/simbrief-ofp'
import { logger } from '../logging/logger'
import { boxClearedLevelFt } from '@shared/atc-info-boxes'
import { requestAltitude, type AltitudeRequestSession } from './altitude-request'
import { greatCircleNm } from '@shared/geo'

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
 *
 * Tightened after the first real long-haul (YBBN-VHHH, 2026-10-02), where a descent clearance
 * to 13,000 ft with the FCU still on FL400 read as "the FCU is above the cleared level" and
 * asked for FL400 at top of descent:
 * - The FCU alone only brings forward the **next planned step**. Any other FCU level is asked
 *   for only once the aircraft is actually climbing to it — a dial-up with no climb (knob
 *   fiddling, a level left set after a descent clearance) asks for nothing.
 * - **No requests past top of descent** (SimBrief's TOD fix). A descent clearance on its own
 *   doesn't stop it — a mid-flight descent can be followed by a climb back up.
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
/** An FCU level within this of the next planned step is that step. */
const PLANNED_MATCH_FT = 300
/** "Actually climbing": above ~500 fpm, held this long. */
const CLIMB_VS_MS = (500 * 0.3048) / 60
const CLIMB_SUSTAIN_MS = 10_000
/** An unplanned FCU level further than this above the cleared level is a slip of the knob. */
const MAX_UNPLANNED_STEP_FT = 4000
/** A plan without a TOD fix: no requests this close to its last fix (the destination). */
const NO_TOD_CUTOFF_NM = 150

export interface RouteFix {
  ident: string
  lat: number
  lon: number
}

export interface StepTarget extends RouteFix {
  altitudeFt: number
  /** Index of this step's fix in the route's fix list — how "already behind us" is judged. */
  order: number
}

export interface StepPlan {
  /** Every navlog fix with a position, in route order. */
  fixes: RouteFix[]
  /** The plan's climbs only. */
  steps: StepTarget[]
  /** Index of SimBrief's TOD fix in `fixes`, or null if the navlog has none. */
  todOrder: number | null
}

/** The OFP's planned step climbs, placed on the route via their navlog fix — `parseOfp` gives
 *  the levels (metric-aware), the raw navlog gives each fix's `pos_lat`/`pos_long` and order.
 *  A step whose fix isn't in the navlog is skipped (the FCU trigger still covers it).
 *
 *  **Down steps are filtered out** (Callum, 2026-10-01): over China the levels swap with
 *  direction, so a plan steps up *and* down. The iniBuilds A350 won't fly a step down and
 *  most pilots never program them, so only a step above every level planned before it counts
 *  — 11,300 m → 10,700 m → 11,900 m keeps just the 11,900 m step.
 *
 * @param ofpJson The flight's stored OFP, or null.
 * @returns The route fixes, the planned climbs and the TOD fix.
 */
export function extractStepPlan(ofpJson: string | null): StepPlan {
  if (!ofpJson) return { fixes: [], steps: [], todOrder: null }
  try {
    const raw = JSON.parse(ofpJson) as { navlog?: { fix?: Record<string, unknown>[] } }
    const navlog = Array.isArray(raw.navlog?.fix) ? raw.navlog.fix : []
    const fixes: RouteFix[] = navlog.flatMap((f) => {
      const lat = Number(f.pos_lat)
      const lon = Number(f.pos_long)
      return typeof f.ident === 'string' && Number.isFinite(lat) && Number.isFinite(lon) ? [{ ident: f.ident, lat, lon }] : []
    })
    const steps: StepTarget[] = []
    let highestFt = -Infinity
    let searchFrom = 0
    for (const step of parseOfp(raw).stepClimbs) {
      const isClimb = step.toAltitudeFt > highestFt + STEP_THRESHOLD_FT
      highestFt = Math.max(highestFt, step.toAltitudeFt)
      // An ident can repeat along a route — each step is looked for after the previous one.
      const order = fixes.findIndex((f, i) => i >= searchFrom && f.ident === step.atIdent)
      if (order < 0) continue
      searchFrom = order
      const fix = fixes[order]
      if (isClimb && fix) steps.push({ ...fix, altitudeFt: step.toAltitudeFt, order })
    }
    const tod = fixes.findIndex((f) => f.ident === 'TOD')
    return { fixes, steps, todOrder: tod >= 0 ? tod : null }
  } catch {
    return { fixes: [], steps: [], todOrder: null }
  }
}

export interface StepClimbDeps {
  getSession: () => (AltitudeRequestSession & { getStatus(): BeyondAtcConnectionStatus }) | undefined
  getActive: () => ActiveTracking | undefined
  getOfpJson: (flightId: number) => string | null
  request?: typeof requestAltitude
  now?: () => number
  /** Decision trail for main.log (console is routed there), so an overnight flight can be
   *  read back afterwards: why a step fired, or why it didn't. */
  log?: (message: string) => void
}

interface Attempt {
  count: number
  lastAt: number
}

/**
 * Turns the step plan, the aircraft's position and BeyondATC's state into level requests, one tick
 * at a time, and reports what it's doing.
 */
export class StepClimbController extends EventEmitter<{ status: [BeyondAtcStepClimbStatus] }> {
  private enabled = false
  private flightId: number | null = null
  private plan: StepPlan = { fixes: [], steps: [], todOrder: null }
  /** The furthest route fix the aircraft has been nearest to — steps before it are behind. */
  private progress = 0
  private readonly attempts = new Map<number, Attempt>()
  private readonly dropped = new Set<number>()
  private inFlight: number | null = null
  private fcu: { valueFt: number; since: number } | null = null
  private climbingSince: number | null = null
  private waitingForClimb: number | null = null
  private pastTopOfDescent = false
  private last: BeyondAtcStepClimbStatus['last'] = null
  private nextStep: BeyondAtcStepClimbStatus['nextStep'] = null
  private lastEmitted = ''
  private readonly request: typeof requestAltitude
  private readonly now: () => number
  private readonly log: (message: string) => void
  private loggedCleared: number | null = null
  /** The last cleared level BeyondATC's InfoBoxes showed this flight. Kept, since the box set
   *  is replaced by the next instruction (a frequency change) minutes later. */
  private boxCleared: number | null = null
  private loggedNext = ''

  constructor(private readonly deps: StepClimbDeps) {
    super()
    this.request = deps.request ?? requestAltitude
    this.now = deps.now ?? Date.now
    this.log = (message) => (deps.log ?? ((line: string) => logger.info(line)))(`[step-climb] ${message}`)
  }

  getStatus(): BeyondAtcStepClimbStatus {
    return {
      enabled: this.enabled,
      nextStep: this.nextStep,
      pendingAltitudeFt: this.inFlight,
      waitingForClimbFt: this.waitingForClimb,
      pastTopOfDescent: this.pastTopOfDescent,
      last: this.last
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled !== this.enabled) this.log(enabled ? 'enabled' : 'disabled')
    this.enabled = enabled
    if (!enabled) {
      this.nextStep = null
      this.fcu = null
      this.waitingForClimb = null
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
    if (active.flightId !== this.flightId) this.followFlight(active.flightId)
    this.trackFcu(t, now, active.phase)
    this.climbingSince = t.verticalSpeedMs > CLIMB_VS_MS ? (this.climbingSince ?? now) : null

    const session = this.deps.getSession()
    const clearedFt = this.clearedLevelFt(t, session)
    this.updateProgress(t)
    const { upcoming, upcomingDistance } = this.findUpcomingStep(t, clearedFt)

    this.waitingForClimb = null
    if (this.inFlight === null && !this.pastTopOfDescent && active.phase === 'cruise' && session?.getStatus().state === 'connected') {
      const target = this.pickTarget(t, now, clearedFt, upcoming, upcomingDistance)
      if (target) this.fire(session, target.altitudeFt, target.reason, now)
    }
    this.emitStatus()
  }

  /**
   * A new flight is being tracked: load its step plan and start over.
   *
   * @param flightId The flight now tracked.
   */
  private followFlight(flightId: number): void {
    this.flightId = flightId
    this.plan = extractStepPlan(this.deps.getOfpJson(flightId))
    this.progress = 0
    this.attempts.clear()
    this.dropped.clear()
    this.last = null
    this.pastTopOfDescent = false
    this.boxCleared = null
    this.log(
      `flight ${flightId}: ${this.plan.fixes.length} route fixes, steps ` +
        (this.plan.steps.map((s) => `${s.ident}@${Math.round(s.altitudeFt)}`).join(' ') || 'none')
    )
  }

  /**
   * Notes when the autopilot's selected altitude changes (by more than 50 ft).
   *
   * @param t This tick.
   * @param now Epoch ms.
   * @param phase The flight phase, for the log.
   */
  private trackFcu(t: SimTelemetry, now: number, phase: ActiveTracking['phase']): void {
    if (typeof t.apSelectedAltitudeM !== 'number') return
    const selectedFt = t.apSelectedAltitudeM * FEET_PER_METRE
    if (!this.fcu || Math.abs(selectedFt - this.fcu.valueFt) > 50) {
      this.fcu = { valueFt: selectedFt, since: now }
      this.log(`FCU altitude ${Math.round(selectedFt)} ft (phase ${phase})`)
    }
  }

  /**
   * The level ATC has cleared, from BeyondATC's InfoBoxes (decisions.md, 2026-10-05: boxes only,
   * no speech), or the current altitude rounded to 1,000 ft when no level has been given.
   *
   * @param t This tick.
   * @param session BeyondATC's connection, if any.
   * @returns Feet.
   */
  private clearedLevelFt(t: SimTelemetry, session: ReturnType<StepClimbDeps['getSession']>): number {
    const boxLevel = session ? boxClearedLevelFt(session.getState().infoBoxes) : null
    if (boxLevel !== null) this.boxCleared = boxLevel
    const clearedFt = this.boxCleared ?? Math.round((t.pressureAltitudeM * FEET_PER_METRE) / 1000) * 1000
    if (clearedFt !== this.loggedCleared) {
      this.loggedCleared = clearedFt
      this.log(`cleared level ${clearedFt} ft (${this.boxCleared !== null ? 'from InfoBoxes' : 'no ATC level, using altitude'})`)
    }
    return clearedFt
  }

  /**
   * Moves progress along the route, and notes passing the top of descent.
   *
   * @param t This tick.
   */
  private updateProgress(t: SimTelemetry): void {
    this.progress = Math.max(this.progress, nearestFixIndex(this.plan.fixes, t.latitude, t.longitude))
    if (!this.pastTopOfDescent && this.isPastTopOfDescent(t)) {
      this.pastTopOfDescent = true
      this.log('past top of descent: no more requests this flight')
    }
  }

  /**
   * The next planned climb still ahead and above the cleared level, shown as the next step.
   * A step already behind (switched on late, or a step not taken) doesn't hold up the ones after it.
   *
   * @param t This tick.
   * @param clearedFt The cleared level, feet.
   * @returns The step, and its distance in nm; both undefined or null when there isn't one.
   */
  private findUpcomingStep(t: SimTelemetry, clearedFt: number): { upcoming: StepTarget | undefined; upcomingDistance: number | null } {
    const upcoming = this.pastTopOfDescent
      ? undefined
      : this.plan.steps.find(
          (s) => s.order >= this.progress && s.altitudeFt > clearedFt + STEP_THRESHOLD_FT && !this.dropped.has(roundLevel(s.altitudeFt))
        )
    const upcomingDistance = upcoming ? greatCircleNm({ lat: t.latitude, lon: t.longitude }, upcoming) : null
    this.nextStep =
      upcoming && upcomingDistance !== null
        ? { ident: upcoming.ident, altitudeFt: upcoming.altitudeFt, distanceNm: Math.round(upcomingDistance) }
        : null
    const nextKey = upcoming ? `${upcoming.ident}@${Math.round(upcoming.altitudeFt)}` : 'none'
    if (nextKey !== this.loggedNext) {
      this.loggedNext = nextKey
      this.log(`next step ${nextKey}${upcomingDistance !== null ? ` (${Math.round(upcomingDistance)} nm)` : ''}`)
    }
    return { upcoming, upcomingDistance }
  }

  /** Nearest-fix progress reaching TOD counts as past it — up to half a leg early, which only
   *  matters to a step planned right at TOD, which never happens.
   *
   * @param t This tick.
   * @returns Whether the top of descent is behind.
   */
  private isPastTopOfDescent(t: SimTelemetry): boolean {
    if (this.plan.todOrder !== null) return this.progress >= this.plan.todOrder
    const destination = this.plan.fixes.at(-1)
    return destination !== undefined && greatCircleNm({ lat: t.latitude, lon: t.longitude }, destination) < NO_TOD_CUTOFF_NM
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
      const fcuFt = this.fcu.valueFt
      if (upcoming && Math.abs(fcuFt - upcoming.altitudeFt) <= PLANNED_MATCH_FT) {
        // The aircraft starting the planned step early — ask for the plan's level now.
        candidates.push({ altitudeFt: upcoming.altitudeFt, reason: 'fcu' })
      } else if (fcuFt <= clearedFt + MAX_UNPLANNED_STEP_FT) {
        if (this.climbingSince !== null && now - this.climbingSince >= CLIMB_SUSTAIN_MS) {
          candidates.push({ altitudeFt: roundLevel(fcuFt), reason: 'fcu' })
        } else {
          this.waitingForClimb = roundLevel(fcuFt)
        }
      }
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
    this.log(`requesting ${Math.round(altitudeFt)} ft (trigger ${reason}, attempt ${attempt.count})`)
    this.emitStatus()
    void this.request(session, altitudeFt)
      .then(({ outcome }) => {
        if (outcome === 'granted') this.attempts.delete(key)
        else if (attempt.count >= MAX_ATTEMPTS) this.dropped.add(key)
        this.log(`request ${key} ft: ${outcome}${this.dropped.has(key) ? ', dropped' : ''}`)
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

function nearestFixIndex(fixes: RouteFix[], lat: number, lon: number): number {
  let best = 0
  let bestDistance = Infinity
  for (const [i, fix] of fixes.entries()) {
    const d = greatCircleNm({ lat, lon }, fix)
    if (d < bestDistance) {
      bestDistance = d
      best = i
    }
  }
  return best
}

/** Levels compared at 100 ft resolution, so FL390 from SimBrief and 39,000 from the FCU are
 *  the same step (and a metric level's odd feet value still has one key).
 *
 * @param feet A level, feet.
 * @returns It, to the nearest 100 ft.
 */
function roundLevel(feet: number): number {
  return Math.round(feet / 100) * 100
}
