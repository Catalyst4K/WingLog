import { describe, expect, it } from 'vitest'
import type { FlightFixtureEvent, ParsedFlightFixture } from '../../src/main/sim/flight-fixture'
import { egllEgcc } from './bases'
import {
  applyTransforms,
  bounceOnRollout,
  changeClearedRunway,
  delaySpokenStand,
  dropAtcLine,
  duplicateAtcLine,
  renameTaxiway,
  renameTaxiwaySegments,
  speedUpTaxi,
  stallFieldUpdates
} from './transforms'

const EGLL = egllEgcc()
const TICKS = EGLL.events.filter((e) => e.type === 'telemetry')

/** `n` real taxi ticks a second apart from 0 s, plus the given lines. */
function slice(n: number, lines: FlightFixtureEvent[] = [], from = 1_500_000): ParsedFlightFixture {
  const ticks = TICKS.filter((e) => e.tOffsetMs >= from)
    .slice(0, n)
    .map((e, i) => ({ ...e, tOffsetMs: i * 1000 }))
  return { header: EGLL.header, events: [...ticks, ...lines].sort((a, b) => a.tOffsetMs - b.tOffsetMs) }
}

const atc = (tOffsetMs: number, text: string): FlightFixtureEvent => ({
  type: 'beyondatc',
  tOffsetMs,
  direction: 'in',
  text
})
const texts = (capture: ParsedFlightFixture): string[] =>
  capture.events.flatMap((e) => (e.type === 'beyondatc' ? [e.text] : []))

// Real lines: flight 230's ZJSY arrival boxes (2026-10-05) and a BeyondATC taxi call.
const STAR = 'InfoBoxes: [{"title":"STAR","info":"UPRS2C"},{"title":"Arrival Runway","info":"08"}]'
const APPROACH =
  'InfoBoxes: [{"title":"Cross SY498","info":"At or above 1,200m"},{"title":"Cleared Approach","info":"ILS-Z approach runway 08"}]'
const TAXI =
  'InfoBoxes: [{"title":"Taxi to Gate","info":"Gate 102"},{"title":"Taxi Via 1","info":"A4"},{"title":"Taxi Via 2","info":"D"}]'
const SPOKEN_TAXI = 'ATC: Test 123, taxi to Stand D207 via C7, Y, F, A2, B, U, cross runway 07C.'

describe('speedUpTaxi', () => {
  it('keeps every nth tick at n times the speed, and brings what follows forward', () => {
    const base = slice(10, [atc(9500, STAR)])
    const fast = speedUpTaxi({ fromMs: 2000, toMs: 6000 }, 2)(base)
    const offsets = fast.events.map((e) => e.tOffsetMs)
    expect(offsets).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 7500])
    const at = (t: number, c: ParsedFlightFixture): number => {
      const e = c.events.find((x) => x.tOffsetMs === t)
      return e?.type === 'telemetry' ? e.data.groundSpeedMs : NaN
    }
    expect(at(3000, fast)).toBeCloseTo(at(4000, base) * 2)
    expect(at(1000, fast)).toBe(at(1000, base))
  })

  it('refuses a factor that is not a whole number', () => {
    expect(() => speedUpTaxi({ fromMs: 0, toMs: 1 }, 1.5)).toThrow(/whole number/)
  })
})

describe('bounceOnRollout', () => {
  it('lifts the ticks just after the first touchdown, and only those', () => {
    const bounced = bounceOnRollout(2, 1)(EGLL)
    const changed = bounced.events.filter((e, i) => e !== EGLL.events[i])
    expect(changed).toHaveLength(2)
    for (const e of changed) {
      expect(e.type === 'telemetry' && !e.data.onGround && e.data.verticalSpeedMs > 0).toBe(true)
    }
  })

  it('refuses a capture with no touchdown', () => {
    expect(() => bounceOnRollout(2)(slice(5))).toThrow(/no touchdown/)
  })
})

describe('changeClearedRunway', () => {
  it('rewrites whole runway idents in boxes and speech, never parts of other values', () => {
    const changed = changeClearedRunway(
      '08',
      '26'
    )(slice(2, [atc(0, STAR), atc(500, APPROACH), atc(800, 'ATC: Test 123, descend to 1,080m, runway 08L')]))
    expect(texts(changed)).toEqual([
      STAR.replace('"08"', '"26"'),
      APPROACH.replace('runway 08', 'runway 26'),
      'ATC: Test 123, descend to 1,080m, runway 08L'
    ])
  })
})

describe('renameTaxiway', () => {
  it('renames the taxiway in the taxi boxes and the spoken clearance, nowhere else', () => {
    const renamed = renameTaxiway(
      'A4',
      'LINK 36'
    )(slice(2, [atc(0, TAXI), atc(500, 'ATC: Test 123, taxi to Gate 102 via A4, D. Contact A4 apron.')]))
    expect(texts(renamed)).toEqual([
      TAXI.replace('"A4"', '"LINK 36"'),
      'ATC: Test 123, taxi to Gate 102 via LINK 36, D. Contact A4 apron.'
    ])
  })

  it('leaves malformed boxes alone', () => {
    const renamed = renameTaxiway(
      'A4',
      'LINK 36'
    )(slice(2, [atc(0, 'InfoBoxes: [not json'), atc(10, 'InfoBoxes: {"title":"x"}')]))
    expect(texts(renamed)).toEqual(['InfoBoxes: [not json', 'InfoBoxes: {"title":"x"}'])
  })

  it('renames the same taxiway in a cached network', () => {
    expect(renameTaxiwaySegments([{ name: 'A4' }, { name: 'D' }, { name: null }], 'A4', 'LINK 36')).toEqual([
      { name: 'LINK 36' },
      { name: 'D' },
      { name: null }
    ])
  })
})

describe('delaySpokenStand', () => {
  it('moves only the spoken stand or gate line', () => {
    const delayed = delaySpokenStand(30)(slice(2, [atc(500, SPOKEN_TAXI), atc(600, TAXI)]))
    expect(delayed.events.filter((e) => e.type === 'beyondatc').map((e) => e.tOffsetMs)).toEqual([
      600, 30_500
    ])
  })
})

describe('dropAtcLine and duplicateAtcLine', () => {
  it('drops a transmission, or sends it twice', () => {
    const base = slice(2, [atc(100, STAR), atc(200, APPROACH)])
    expect(texts(dropAtcLine(/STAR/)(base))).toEqual([APPROACH])
    const repeated = duplicateAtcLine(/STAR/, 700)(base)
    expect(repeated.events.filter((e) => e.type === 'beyondatc').map((e) => e.tOffsetMs)).toEqual([
      100, 200, 800
    ])
  })
})

describe('stallFieldUpdates', () => {
  it('delays one stream only', () => {
    const base = slice(2, [atc(100, STAR), { type: 'gsx', tOffsetMs: 200, direction: 'in', text: '{}' }])
    const stalled = stallFieldUpdates('beyondatc', 5)(base)
    expect(stalled.events.filter((e) => e.type !== 'telemetry').map((e) => [e.type, e.tOffsetMs])).toEqual([
      ['gsx', 200],
      ['beyondatc', 5100]
    ])
  })
})

describe('applyTransforms', () => {
  it('applies in order', () => {
    const out = applyTransforms(slice(2, [atc(100, STAR)]), [
      changeClearedRunway('08', '26'),
      changeClearedRunway('26', '35')
    ])
    expect(texts(out)).toEqual([STAR.replace('"08"', '"35"')])
  })
})
