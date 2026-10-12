import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FlightFixtureEvent } from '../../src/main/sim/flight-fixture'
import type { Sample } from '../scenarios/harness'
import { arrivalCardPrompt, landingMatchesSimRunway, samePhasesAsLive } from '../scenarios/rules'
import {
  approachProfile,
  atcSilences,
  findCapture,
  meanCrossM,
  phaseFlicker,
  phaseSequence,
  phaseSpans,
  simRunwayLine,
  type RunwayLine
} from './flight'

// WSSS 20R from the sim's own facility data (flight 236, 2026-10-12), and the same runway's
// physical end in the vendored OurAirports slice.
const SIM_20R: RunwayLine = {
  source: 'sim',
  ident: '20R',
  thresholdLat: 1.3757575921283205,
  thresholdLon: 103.98878019536174,
  headingTrueDeg: 203,
  lengthM: 3221.2,
  widthM: 60
}
const DATABASE_20R: RunwayLine = {
  source: 'database',
  ident: '20R',
  thresholdLat: 1.38241,
  thresholdLon: 103.991997,
  headingTrueDeg: 203,
  lengthM: 4000,
  widthM: 60
}

// Three ticks of that landing's final approach and roll, centred on the sim's runway line: the
// middle one is the touchdown tick.
const TRACK = [
  { tOffsetMs: 0, latitude: 1.37576, longitude: 103.98878, onGround: false },
  { tOffsetMs: 10_000, latitude: 1.37576, longitude: 103.98878, onGround: true },
  { tOffsetMs: 20_000, latitude: 1.37576, longitude: 103.98878, onGround: true }
]

const atc = (tOffsetMs: number): FlightFixtureEvent => ({
  type: 'beyondatc',
  tOffsetMs,
  direction: 'in',
  text: 'ATC: Speedbird 2 Super, contact Singapore Radar 133.25.'
})

describe('approachProfile', () => {
  it('measures a point on the sim threshold as on the centreline, and about 40 m off the database line', () => {
    const sim = approachProfile(TRACK, SIM_20R, 10_000, 10, 10)
    const database = approachProfile(TRACK, DATABASE_20R, 10_000, 10, 10)
    expect(sim.map((p) => p.tS)).toEqual([-10, 0, 10])
    expect(Math.abs(sim[1].crossM)).toBeLessThan(1)
    expect(Math.abs(sim[1].alongM)).toBeLessThan(1)
    // The database's line is the same strip shifted: this point sits tens of metres left of it.
    expect(Math.abs(database[1].crossM)).toBeGreaterThan(30)
  })

  it('keeps only the ticks inside the window', () => {
    expect(approachProfile(TRACK, SIM_20R, 10_000, 5, 5).map((p) => p.tS)).toEqual([0])
  })
})

describe('meanCrossM', () => {
  it('averages a stretch and returns null with nothing in range', () => {
    const points = [
      { tS: -2, alongM: 0, crossM: 4 },
      { tS: -1, alongM: 0, crossM: 8 }
    ]
    expect(meanCrossM(points, -3, 0)).toBe(6)
    expect(meanCrossM(points, 1, 2)).toBeNull()
  })
})

describe('simRunwayLine', () => {
  it('finds a cached runway by ident', () => {
    const runways = [
      {
        ident: '02L',
        headingTrueDeg: 23,
        lengthM: 3000,
        widthM: 60,
        surface: 4,
        thresholdLat: 1,
        thresholdLon: 2
      }
    ]
    expect(simRunwayLine(runways, '02L')?.thresholdLat).toBe(1)
    expect(simRunwayLine(runways, '20R')).toBeNull()
  })
})

describe('atcSilences', () => {
  it('reports a long gap with the lines that came after it, and ignores other messages', () => {
    const events: FlightFixtureEvent[] = [
      atc(0),
      { type: 'beyondatc', tOffsetMs: 60_000, direction: 'in', text: 'CommsState: {}' },
      atc(40 * 60_000),
      atc(41 * 60_000),
      atc(50 * 60_000)
    ]
    expect(atcSilences(events, 30 * 60_000)).toEqual([{ fromMs: 0, toMs: 40 * 60_000, burstLines: 2 }])
  })
})

describe('phase helpers', () => {
  const samples = [
    { tOffsetMs: 0, phase: 'cruise' as const },
    { tOffsetMs: 1000, phase: 'cruise' as const },
    { tOffsetMs: 2000, phase: 'descent' as const },
    { tOffsetMs: 3000, phase: 'cruise' as const },
    { tOffsetMs: 4000, phase: null }
  ]

  it('collapses repeats and spans the clock', () => {
    expect(phaseSequence(samples.map((s) => s.phase))).toEqual(['cruise', 'descent', 'cruise'])
    expect(phaseSpans(samples)).toEqual([
      { phase: 'cruise', fromMs: 0, toMs: 1000 },
      { phase: 'descent', fromMs: 2000, toMs: 2000 },
      { phase: 'cruise', fromMs: 3000, toMs: 3000 }
    ])
  })

  it('names a descent blip between cruise spans, and not a real descent', () => {
    expect(phaseFlicker(phaseSpans(samples), 60_000)).toHaveLength(1)
    const real = [
      { phase: 'cruise' as const, fromMs: 0, toMs: 1000 },
      { phase: 'descent' as const, fromMs: 1000, toMs: 600_000 },
      { phase: 'cruise' as const, fromMs: 600_000, toMs: 700_000 }
    ]
    expect(phaseFlicker(real, 60_000)).toEqual([])
  })
})

describe('landingMatchesSimRunway', () => {
  const check = {
    recordedRunway: '20R',
    recordedOffsetM: 38.3,
    recordedDistanceM: 1030,
    measuredOffsetM: -1.9,
    measuredDistanceM: 949
  }
  it("fails flight 236's landing, 40 m apart, and passes one that agrees", () => {
    expect(landingMatchesSimRunway(check, 10)).toHaveLength(1)
    expect(landingMatchesSimRunway({ ...check, recordedOffsetM: -0.5 }, 10)).toEqual([])
  })
  it('fails when the landing has no offset at all', () => {
    expect(landingMatchesSimRunway({ ...check, recordedOffsetM: null }, 10)).toHaveLength(1)
  })
})

describe('samePhasesAsLive', () => {
  it('ignores the live flight ending in shutdown, and names any other difference', () => {
    expect(samePhasesAsLive(['taxi', 'takeoff'], ['taxi', 'takeoff', 'shutdown'])).toEqual([])
    expect(samePhasesAsLive(['taxi'], ['taxi', 'takeoff'])).toHaveLength(1)
  })
})

describe('arrivalCardPrompt', () => {
  const sample = (tOffsetMs: number, boxed: boolean, card: boolean): Sample =>
    ({
      tOffsetMs,
      infoBoxes: boxed ? [{ title: 'Arrival Runway', info: '20R' }] : [],
      arrival: card ? { runway: '20R' } : null
    }) as Sample
  it('passes a card that follows the boxes at once and fails one that comes late or never', () => {
    expect(arrivalCardPrompt([sample(0, false, false), sample(1000, true, true)], 60)).toEqual([])
    expect(arrivalCardPrompt([sample(0, true, false), sample(120_000, true, true)], 60)).toHaveLength(1)
    expect(arrivalCardPrompt([sample(0, true, false)], 60)).toHaveLength(1)
    expect(arrivalCardPrompt([sample(0, false, false)], 60)).toHaveLength(1)
  })
})

describe('findCapture', () => {
  it('takes the newest flight capture, an explicit file name, or fails with no capture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'winglog-captures-'))
    expect(() => findCapture(dir, undefined)).toThrow(/No dev-build capture/)
    mkdirSync(join(dir, 'captures'))
    const older = join(dir, 'captures', 'flight-1-a.ndjson')
    const newer = join(dir, 'captures', 'flight-2-b.ndjson')
    writeFileSync(older, '')
    writeFileSync(newer, '')
    writeFileSync(join(dir, 'captures', 'notes.txt'), '')
    utimesSync(older, new Date(2026, 9, 1), new Date(2026, 9, 1))
    utimesSync(newer, new Date(2026, 9, 2), new Date(2026, 9, 2))
    expect(findCapture(dir, undefined)).toBe(newer)
    expect(findCapture(dir, 'flight-1-a.ndjson')).toBe(older)
    expect(() => findCapture(dir, 'missing.ndjson')).toThrow(/not found/)
  })
})
