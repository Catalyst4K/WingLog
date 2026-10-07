import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BeyondAtcState } from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { boxConfirmsLevel, levelLabelToFeet, pickLevelLabel, requestAltitude } from './altitude-request'

// Real Actions lists, captured live 2026-10-01 (Fenix A320, cleared FL380 — winglog-backend's
// docs/beyondatc-notes.md, "requesting a new cruise altitude"). The cleared-level box is the
// `Climb` box seen on the VHHH-ZJSY flight, 2026-10-05.
const CRUISE_ACTIONS = [
  'Call Ready for Descent',
  'Request Approach Change',
  'Request Runway Change',
  'Request Altitude Change',
  'Request Direct to Fix',
  'Submit Turbulence Pirep',
  'Submit Icing Pirep',
  'Radio Check'
]
const LEVEL_ACTIONS = ['Cancel Altitude Change', 'FL320', 'FL340', 'FL360', 'FL380', 'Say Again']

/** Stands in for BeyondAtcService: replays BeyondATC's responses to each set_action. */
class FakeBeyondAtc extends EventEmitter {
  state: BeyondAtcState = { ...EMPTY_BEYONDATC_STATE, actions: CRUISE_ACTIONS }
  sent: string[] = []
  respond = true
  /** The cleared level BeyondATC's box shows after the request. */
  answer = (label: string): string => label

  getState(): BeyondAtcState {
    return this.state
  }
  setAction(label: string): void {
    this.sent.push(label)
    if (!this.respond) return
    setTimeout(() => {
      if (label === 'Request Altitude Change') {
        this.setState({ actions: LEVEL_ACTIONS })
      } else if (label === 'Cancel Altitude Change') {
        this.setState({ actions: CRUISE_ACTIONS })
      } else {
        this.setState({
          actions: CRUISE_ACTIONS,
          infoBoxes: [{ title: 'Climb', info: this.answer(label) }],
          infoBoxesAt: Date.now()
        })
      }
    }, 1000)
  }
  private setState(change: Partial<BeyondAtcState>): void {
    this.state = { ...this.state, ...change }
    this.emit('state', this.state)
  }
}

describe('levelLabelToFeet / pickLevelLabel / boxConfirmsLevel', () => {
  it('reads FL labels, and metric ones in either notation', () => {
    expect(levelLabelToFeet('FL380')).toBe(38000)
    expect(levelLabelToFeet('11300m')).toBeCloseTo(37073, 0)
    expect(levelLabelToFeet('11,300 m')).toBeCloseTo(37073, 0)
    expect(levelLabelToFeet('Say Again')).toBeNull()
  })

  it('picks the offered level matching the target, or nothing', () => {
    expect(pickLevelLabel(LEVEL_ACTIONS, 36000)).toBe('FL360')
    expect(pickLevelLabel(LEVEL_ACTIONS, 40000)).toBeNull()
    // A SimBrief metric step (11,300 m) against BeyondATC's metric label over China —
    // "11,300m", per Callum (2026-10-01).
    expect(pickLevelLabel(['Cancel Altitude Change', '10,700m', '11,300m', '11,900m'], 11300 / 0.3048)).toBe(
      '11,300m'
    )
    expect(pickLevelLabel(['Cancel Altitude Change', '10700m', '11300m'], 11300 / 0.3048)).toBe('11300m')
  })

  it('confirms from a cleared-level box that changed after the request', () => {
    const boxes = (info: string, at: number): BeyondAtcState => ({
      ...EMPTY_BEYONDATC_STATE,
      infoBoxes: [{ title: 'Climb', info }],
      infoBoxesAt: at
    })
    expect(boxConfirmsLevel(boxes('FL360', 2000), 'FL360', 1000)).toBe(true)
    expect(boxConfirmsLevel(boxes('FL340', 2000), 'FL360', 1000)).toBe(false)
    // Already showing before the request: not an answer to it.
    expect(boxConfirmsLevel(boxes('FL360', 500), 'FL360', 1000)).toBe(false)
    // A metric box against a metric label (China).
    expect(boxConfirmsLevel(boxes('11,300m', 2000), '11,300m', 1000)).toBe(true)
    expect(
      boxConfirmsLevel(
        {
          ...EMPTY_BEYONDATC_STATE,
          infoBoxes: [{ title: 'Center Frequency', info: '133.2' }],
          infoBoxesAt: 2000
        },
        'FL360',
        1000
      )
    ).toBe(false)
  })
})

describe('requestAltitude', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the real two-step flow and reports granted (live capture, 2026-10-01)', async () => {
    const atc = new FakeBeyondAtc()
    const result = requestAltitude(atc, 36000)
    await vi.advanceTimersByTimeAsync(3000)

    expect(await result).toEqual({ outcome: 'granted', label: 'FL360' })
    expect(atc.sent).toEqual(['Request Altitude Change', 'FL360'])
  })

  it('cancels when the wanted level is not offered (FL400 above the A320 list)', async () => {
    const atc = new FakeBeyondAtc()
    const result = requestAltitude(atc, 40000)
    await vi.advanceTimersByTimeAsync(3000)

    expect(await result).toEqual({ outcome: 'notOffered', label: null })
    expect(atc.sent).toEqual(['Request Altitude Change', 'Cancel Altitude Change'])
  })

  it('is unavailable when BeyondATC is not offering the request', async () => {
    const atc = new FakeBeyondAtc()
    atc.state = { ...atc.state, actions: ['Radio Check'] }
    expect(await requestAltitude(atc, 36000)).toEqual({ outcome: 'unavailable', label: null })
    expect(atc.sent).toEqual([])
  })

  it('gives up if the level list never appears', async () => {
    const atc = new FakeBeyondAtc()
    atc.respond = false
    const result = requestAltitude(atc, 36000)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await result).toEqual({ outcome: 'noMenu', label: null })
  })

  it('reports no answer when the box shows a different level', async () => {
    const atc = new FakeBeyondAtc()
    atc.answer = () => 'FL340'
    const result = requestAltitude(atc, 36000)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await result).toEqual({ outcome: 'noAnswer', label: 'FL360' })
  })
})
