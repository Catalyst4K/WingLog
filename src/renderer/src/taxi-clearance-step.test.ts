import { describe, expect, it } from 'vitest'
import type { BeyondAtcInfoBox, BeyondAtcTranscriptEntry } from '@shared/ipc'
import {
  HOLD_SHORT_PAIR_MS,
  INITIAL_TAXI_MEMORY,
  isDeparted,
  stepTaxiBoxes,
  stepTaxiTranscript
} from './taxi-clearance-step'

const via = (names: string[]): BeyondAtcInfoBox[] =>
  names.map((info, i) => ({ title: `Taxi Via ${i + 1}`, info }))
// ZJSY: cleared "taxi via D, B7, A", then ATC adds the spoken hold short.
const ROUTE = [...via(['D', 'B7', 'A']), { title: 'Hold Position', info: 'A' }]
const HOLD_SHORT_LINE = (ts: number): BeyondAtcTranscriptEntry =>
  ({
    ts,
    speaker: 'atc',
    text: 'Test 230, taxi via D, B7, A, hold short of runway 08.'
  }) as BeyondAtcTranscriptEntry
const HERE = { lat: 30.9, lon: 121.8 }

describe('stepTaxiBoxes', () => {
  it('takes a taxi clearance from the boxes, starting at the aircraft, and remembers it', () => {
    const { memory, clearance } = stepTaxiBoxes(INITIAL_TAXI_MEMORY, ROUTE, HERE, 5_000)
    expect(clearance).toMatchObject({ taxiways: ['D', 'B7', 'A'], from: HERE })
    expect(memory).toMatchObject({ clearance, boxAt: 5_000 })
    expect(INITIAL_TAXI_MEMORY.clearance).toBeNull()
  })

  it('reads the same boxes once, and ignores boxes with no taxi clearance', () => {
    const first = stepTaxiBoxes(INITIAL_TAXI_MEMORY, ROUTE, HERE, 1_000)
    const again = stepTaxiBoxes(first.memory, ROUTE, HERE, 2_000)
    expect(again).toEqual({ memory: first.memory, clearance: null })
    const noise = stepTaxiBoxes(first.memory, [{ title: 'Center Frequency', info: '132.205' }], HERE, 3_000)
    expect(noise).toEqual({ memory: first.memory, clearance: null })
  })

  it('adds a hold short heard just before the boxes, but not one heard long before', () => {
    const heard = stepTaxiTranscript(INITIAL_TAXI_MEMORY, [HOLD_SHORT_LINE(100)], 10_000).memory
    expect(stepTaxiBoxes(heard, ROUTE, HERE, 10_000 + HOLD_SHORT_PAIR_MS).clearance?.holdShortRunway).toBe(
      '08'
    )
    expect(
      stepTaxiBoxes(heard, ROUTE, HERE, 10_001 + HOLD_SHORT_PAIR_MS).clearance?.holdShortRunway
    ).toBeNull()
  })
})

describe('stepTaxiTranscript', () => {
  it('adds a spoken hold short to a clearance taken from the boxes within the pairing window', () => {
    const taken = stepTaxiBoxes(INITIAL_TAXI_MEMORY, ROUTE, HERE, 1_000).memory
    const { memory, clearance } = stepTaxiTranscript(taken, [HOLD_SHORT_LINE(50)], 1_000 + HOLD_SHORT_PAIR_MS)
    expect(clearance?.holdShortRunway).toBe('08')
    expect(memory.clearance).toBe(clearance)
  })

  it('leaves an older clearance alone, but still remembers the hold short for the next boxes', () => {
    const taken = stepTaxiBoxes(INITIAL_TAXI_MEMORY, ROUTE, HERE, 1_000).memory
    const { memory, clearance } = stepTaxiTranscript(taken, [HOLD_SHORT_LINE(50)], 1_001 + HOLD_SHORT_PAIR_MS)
    expect(clearance).toBeNull()
    expect(memory.holdShort).toEqual({ runway: '08', at: 1_001 + HOLD_SHORT_PAIR_MS })
  })

  it('reads each line once, and only ATC lines', () => {
    const pilot = { ts: 10, speaker: 'player', text: 'hold short of runway 27L.' } as BeyondAtcTranscriptEntry
    const first = stepTaxiTranscript(INITIAL_TAXI_MEMORY, [pilot, HOLD_SHORT_LINE(20)], 5_000)
    expect(first.memory).toMatchObject({ lastTranscriptTs: 20, holdShort: { runway: '08', at: 5_000 } })
    const second = stepTaxiTranscript(first.memory, [pilot, HOLD_SHORT_LINE(20)], 9_000)
    expect(second.memory).toBe(first.memory)
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
