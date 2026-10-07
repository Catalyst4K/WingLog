/**
 * The step-climb plan and its constants (see step-climb.ts for the feature): the OFP's planned climbs placed on the route,
 * and the thresholds the decision in step-climb-step.ts uses.
 */
import { parseOfp } from '@shared/simbrief-ofp'
import { greatCircleNm, METRES_PER_NM } from '@shared/geo'
import { METRES_PER_FOOT } from '@shared/units'

export const FEET_PER_METRE = 1 / METRES_PER_FOOT
/** "Under a minute from the step" — measured as distance at the current ground speed. */
export const SIMBRIEF_LEAD_S = 60
/** Floor for the lead distance, so a slow-moving test (or a ground-speed glitch) still fires. */
export const MIN_LEAD_NM = 2
/** A knob sweep passes every value on the way (seen live on the Fenix) — only act once the
 *  selected altitude has sat still this long. */
export const FCU_SETTLE_MS = 10_000
/** Anything this close to the cleared level is noise or the same level, not a step. */
export const STEP_THRESHOLD_FT = 500
export const RETRY_AFTER_MS = 120_000
export const MAX_ATTEMPTS = 2
/** An FCU level within this of the next planned step is that step. */
export const PLANNED_MATCH_FT = 300
/** "Actually climbing": above ~500 fpm, held this long. */
export const CLIMB_VS_MS = (500 * METRES_PER_FOOT) / 60
export const CLIMB_SUSTAIN_MS = 10_000
/** An unplanned FCU level further than this above the cleared level is a slip of the knob. */
export const MAX_UNPLANNED_STEP_FT = 4000
/** A plan without a TOD fix: no requests this close to its last fix (the destination). */
export const NO_TOD_CUTOFF_NM = 150
/** The least the selected altitude must move to count as a change, feet. */
export const FCU_CHANGE_FT = 50

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

/** A plan with nothing in it. */
export const EMPTY_STEP_PLAN: StepPlan = { fixes: [], steps: [], todOrder: null }

/** The OFP's planned step climbs, placed on the route via their navlog fix: `parseOfp` gives the levels (metric-aware), the raw
 *  navlog gives each fix's `pos_lat`/`pos_long` and order. A step whose fix isn't in the navlog is skipped (the FCU trigger still
 *  covers it).
 *
 *  **Down steps are filtered out**: over China the levels swap with direction, so a plan steps up *and* down, but the iniBuilds A350
 *  won't fly a step down and most pilots never program them. Only a step above every level planned before it counts: 11,300 m ->
 *  10,700 m -> 11,900 m keeps just the 11,900 m step.
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
      return typeof f.ident === 'string' && Number.isFinite(lat) && Number.isFinite(lon)
        ? [{ ident: f.ident, lat, lon }]
        : []
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

/**
 * The route fix nearest a position.
 *
 * @param fixes The route's fixes.
 * @param lat Latitude, degrees.
 * @param lon Longitude, degrees.
 * @returns The index of the nearest fix, 0 for an empty route.
 */
export function nearestFixIndex(fixes: RouteFix[], lat: number, lon: number): number {
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
export function roundLevel(feet: number): number {
  return Math.round(feet / 100) * 100
}

/**
 * The lead distance for a planned step: how far from the step point the request goes out.
 *
 * @param groundSpeedMs Ground speed, metres per second.
 * @returns Nautical miles, at least MIN_LEAD_NM.
 */
export function leadDistanceNm(groundSpeedMs: number): number {
  return Math.max(MIN_LEAD_NM, ((groundSpeedMs * 3600) / METRES_PER_NM) * (SIMBRIEF_LEAD_S / 3600))
}
