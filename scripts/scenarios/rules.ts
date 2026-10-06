/**
 * Rules a scenario's timeline must keep, whatever the capture or transform
 * (flightdeck-backend docs/plans/robustness/scenario-testing.md Part 2). Rules, not snapshots:
 * each returns the moments it was broken, described for a person, so a failure says what went
 * wrong and when. An empty list is a pass.
 */
import type { NavdataRunway } from '../../src/main/navdata/navdata-provider'
import { isOnRunway } from '../../src/main/tracking/runway-check'
import type { Sample } from './harness'

/** Ground samples in climb or cruise tolerated in a row: a bounce's few seconds. */
const MAX_GROUND_SAMPLES_AIRBORNE_PHASE = 3

function at(sample: Sample): string {
  return `${(sample.tOffsetMs / 1000).toFixed(1)} s`
}

/** The takeoff phase only ever starts on a runway, never on a fast taxi (flight 230, VHHH). */
export function takeoffOnlyOnRunway(samples: Sample[], runways: NavdataRunway[]): string[] {
  return samples
    .filter((s, i) => s.phase === 'takeoff' && samples[i - 1]?.phase !== 'takeoff')
    .filter((s) => isOnRunway(runways, s.telemetry.latitude, s.telemetry.longitude) === false)
    .map((s) => `takeoff started off every runway at ${at(s)} (${s.telemetry.latitude.toFixed(5)}, ${s.telemetry.longitude.toFixed(5)})`)
}

/** Never more than a bounce's worth of ground ticks in climb or cruise (flight 227, #108). */
export function neverAirbornePhaseOnGround(samples: Sample[]): string[] {
  const broken: string[] = []
  let streak = 0
  for (const s of samples) {
    if (s.event !== 'telemetry') continue
    streak = s.telemetry.onGround && (s.phase === 'climb' || s.phase === 'cruise') ? streak + 1 : 0
    if (streak === MAX_GROUND_SAMPLES_AIRBORNE_PHASE + 1) broken.push(`${s.phase} on the ground for more than ${MAX_GROUND_SAMPLES_AIRBORNE_PHASE} ticks at ${at(s)}`)
  }
  return broken
}

/** After a landing, the flight gets back to taxi (or ends): a bounce never strands it. */
export function taxiAfterLanding(samples: Sample[]): string[] {
  const landed = samples.findIndex((s) => s.phase === 'landing')
  if (landed < 0) return ['never reached landing']
  const after = samples.slice(landed)
  return after.some((s) => s.phase === 'taxi' || s.phase === 'shutdown' || s.phase === null) ? [] : [`stuck after landing at ${at(samples[landed])}`]
}

/** The runway a set of boxes clears for arrival (`Arrival Runway`, `Landing Runway`), if any. */
function boxedArrivalRunway(sample: Sample): string | null {
  return sample.infoBoxes.find((b) => /^(arrival|landing) runway$/i.test(b.title.trim()))?.info.trim() ?? null
}

/**
 * The arrival card, once ATC has given the STAR, is kept until touchdown (#110), and always shows
 * the runway the latest boxes cleared, from the moment they clear it (#109).
 *
 * @param runway The runway the capture's ATC last cleared.
 */
export function arrivalCardUntilTouchdown(samples: Sample[], runway: string): string[] {
  const first = samples.findIndex((s) => s.arrival !== null)
  if (first < 0) return ['the arrival card never appeared']
  const touchdown = samples.findIndex((s, i) => i > first && s.phase === 'landing')
  const end = touchdown < 0 ? samples.length : touchdown
  const broken: string[] = []
  let cleared: string | null = null
  for (const s of samples.slice(0, end)) {
    cleared = boxedArrivalRunway(s) ?? cleared
    if (s.arrival === null) {
      if (cleared !== null) broken.push(`arrival card lost at ${at(s)}`)
    } else if (cleared !== null && s.arrival.runway !== cleared) {
      broken.push(`arrival card runway ${s.arrival.runway ?? 'none'} at ${at(s)}, ATC cleared ${cleared}`)
    }
  }
  const last = samples[end - 1]?.arrival
  if (last && last.runway !== runway) broken.push(`arrival card runway ${last.runway} before touchdown, ATC cleared ${runway}`)
  if (last?.approachIdent && !last.approachIdent.endsWith(` ${runway}`)) broken.push(`arrival card approach ${last.approachIdent} is not for runway ${runway}`)
  if (touchdown >= 0 && samples.slice(touchdown).some((s) => s.arrival !== null)) broken.push('arrival card still shown after touchdown')
  return broken
}

/** The gate is known from the moment a box names it, without waiting for speech (#112). */
export function gateWithItsBox(samples: Sample[], gate: string): string[] {
  const named = samples.findIndex((s) => s.infoBoxes.some((b) => /gate/i.test(b.title) && b.info.includes(gate)))
  if (named < 0) return [`no box named gate ${gate}`]
  return samples[named].assignedGate === gate ? [] : [`gate ${gate} named at ${at(samples[named])} but assigned ${samples[named].assignedGate ?? 'nothing'}`]
}
