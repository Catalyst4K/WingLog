import { describe, expect, it } from 'vitest'
import type { BeyondAtcInfoBox } from '@shared/ipc'
import { INITIAL_TAXI_MEMORY, isDeparted, stepTaxiBoxes } from './taxi-clearance-step'

const via = (names: string[]): BeyondAtcInfoBox[] =>
  names.map((info, i) => ({ title: `Taxi Via ${i + 1}`, info }))
// ZJSY: cleared "taxi via D, B7, A" to the holding point A.
const ROUTE = [...via(['D', 'B7', 'A']), { title: 'Hold Position', info: 'A' }]
const HERE = { lat: 30.9, lon: 121.8 }

describe('stepTaxiBoxes', () => {
  it('takes a taxi clearance from the boxes, starting at the aircraft, and remembers it', () => {
    const { memory, clearance } = stepTaxiBoxes(INITIAL_TAXI_MEMORY, ROUTE, HERE, 5_000)
    expect(clearance).toMatchObject({ taxiways: ['D', 'B7', 'A'], from: HERE })
    expect(memory).toMatchObject({ clearance, boxAt: 5_000 })
    expect(INITIAL_TAXI_MEMORY.clearance).toBeNull()
  })

  it('keeps which way the nose pointed as the clearance arrived, for the line to start that way', () => {
    const { clearance } = stepTaxiBoxes(INITIAL_TAXI_MEMORY, ROUTE, { ...HERE, headingDeg: 262 }, 5_000)
    expect(clearance?.from).toEqual({ ...HERE, headingDeg: 262 })
  })

  it('reads the same boxes once, and ignores boxes with no taxi clearance', () => {
    const first = stepTaxiBoxes(INITIAL_TAXI_MEMORY, ROUTE, HERE, 1_000)
    const again = stepTaxiBoxes(first.memory, ROUTE, HERE, 2_000)
    expect(again).toEqual({ memory: first.memory, clearance: null })
    const noise = stepTaxiBoxes(first.memory, [{ title: 'Center Frequency', info: '132.205' }], HERE, 3_000)
    expect(noise).toEqual({ memory: first.memory, clearance: null })
  })

  it('takes the hold short from its own box (EGLL and RKSI, 2026-10-15 and 16), never from what ATC said', () => {
    const boxes = [...via(['P8', 'P']), { title: 'Hold Short', info: '34R' }]
    expect(stepTaxiBoxes(INITIAL_TAXI_MEMORY, boxes, HERE, 1_000).clearance).toMatchObject({
      taxiways: ['P8', 'P'],
      holdShortRunway: '34R'
    })
    // The same route without the box has no hold short, whatever ATC went on to say.
    expect(
      stepTaxiBoxes(INITIAL_TAXI_MEMORY, via(['P8', 'P']), HERE, 1_000).clearance?.holdShortRunway
    ).toBeNull()
  })
})

describe('isDeparted', () => {
  it('is true from the takeoff roll until descent ends, false on the ground and with no flight', () => {
    expect(['takeoff', 'climb', 'cruise', 'descent'].every((p) => isDeparted(p as never))).toBe(true)
    expect(['preflight', 'pushback', 'taxi', 'landing', 'shutdown'].some((p) => isDeparted(p as never))).toBe(
      false
    )
    expect(isDeparted(null)).toBe(false)
  })
})
