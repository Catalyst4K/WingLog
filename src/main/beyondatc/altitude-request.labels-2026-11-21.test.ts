import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BeyondAtcState } from '@shared/ipc'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { findCancelAltitudeAction, findRequestAltitudeAction, requestAltitude } from './altitude-request'

// BeyondATC's labels as they arrive since the build Callum flew on 2026-11-21 (flight 446, EGCC-VHHH, capture
// flight-446-2026-11-21T22-54-16-797Z.ndjson, lines 20615-20660): a menu that opens another menu ends in "..",
// the level list comes straight back, and its cancel entry is plain "Cancel" (no "Say Again").
const CRUISE_ACTIONS = [
  'Call Ready for Descent',
  'Request Altitude Change..',
  'Request Direct to Fix..',
  'Submit PIREP..',
  'Radio Check'
]
const LEVEL_ACTIONS = ['FL290', 'FL310', 'FL330', 'FL350', 'FL370', 'FL390', 'FL410', 'Cancel']

/** Stands in for BeyondAtcService, answering each set_action the way the 446 capture shows. */
class RealLabelsBeyondAtc extends EventEmitter {
  state: BeyondAtcState = { ...EMPTY_BEYONDATC_STATE, actions: CRUISE_ACTIONS }
  sent: string[] = []
  /** False while BeyondATC is busy with other traffic: it takes the request and shows no list. */
  respond = true

  getState(): BeyondAtcState {
    return this.state
  }
  setAction(label: string): void {
    this.sent.push(label)
    // Like BeyondAtcService: a label that is not on offer is silently ignored.
    if (!this.state.actions.includes(label) || !this.respond) return
    setTimeout(() => {
      if (label === 'Request Altitude Change..') {
        this.setState({ actions: LEVEL_ACTIONS })
      } else if (label === 'Cancel') {
        this.setState({ actions: CRUISE_ACTIONS })
      } else {
        this.setState({
          actions: CRUISE_ACTIONS,
          infoBoxes: [{ title: 'Maintain', info: label }],
          infoBoxesAt: Date.now()
        })
      }
    }, 50)
  }
  private setState(change: Partial<BeyondAtcState>): void {
    this.state = { ...this.state, ...change }
    this.emit('state', this.state)
  }
}

describe('requestAltitude against the labels BeyondATC sends since 2026-11-21', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('requests and is granted when the menu entry is "Request Altitude Change.." (flight 446: logged "unavailable" three times)', async () => {
    const atc = new RealLabelsBeyondAtc()
    const result = requestAltitude(atc, 37000)
    await vi.advanceTimersByTimeAsync(3000)

    expect(await result).toEqual({ outcome: 'granted', label: 'FL370' })
    expect(atc.sent).toEqual(['Request Altitude Change..', 'FL370'])
  })

  it('cancels with the list\'s own "Cancel" entry when the wanted level is not offered', async () => {
    const atc = new RealLabelsBeyondAtc()
    const result = requestAltitude(atc, 40000)
    await vi.advanceTimersByTimeAsync(3000)

    expect(await result).toEqual({ outcome: 'notOffered', label: null })
    expect(atc.sent).toEqual(['Request Altitude Change..', 'Cancel'])
  })

  it('closes a level list that turns up after it gave up, with its "Cancel" entry', async () => {
    const atc = new RealLabelsBeyondAtc()
    atc.respond = false
    const result = requestAltitude(atc, 37000)
    await vi.advanceTimersByTimeAsync(65_000)
    expect(await result).toMatchObject({ outcome: 'noMenu', label: null })
    atc.sent.length = 0

    // The list arrives two minutes late.
    await vi.advanceTimersByTimeAsync(60_000)
    atc.state = { ...atc.state, actions: LEVEL_ACTIONS }
    atc.emit('state', atc.state)
    expect(atc.sent).toEqual(['Cancel'])
    // Only the once, even if BeyondATC lists it again.
    atc.emit('state', atc.state)
    expect(atc.sent).toEqual(['Cancel'])
  })

  it('uses a level list that is already open, with its "Cancel" entry, instead of reporting unavailable', async () => {
    const atc = new RealLabelsBeyondAtc()
    atc.state = { ...atc.state, actions: LEVEL_ACTIONS }
    const result = requestAltitude(atc, 35000)
    await vi.advanceTimersByTimeAsync(3000)

    expect(await result).toEqual({ outcome: 'granted', label: 'FL350' })
    expect(atc.sent).toEqual(['FL350'])
  })

  it('does not take a "Cancel" with no level beside it for an open level list', async () => {
    const atc = new RealLabelsBeyondAtc()
    atc.state = { ...atc.state, actions: ['Cancel', 'Radio Check'] }

    expect(await requestAltitude(atc, 37000)).toEqual({ outcome: 'unavailable', label: null })
    expect(atc.sent).toEqual([])
  })
})

describe('findRequestAltitudeAction', () => {
  it('finds the entry with or without its dots, in any case, and returns BeyondATC’s own label', () => {
    expect(findRequestAltitudeAction(['Radio Check', 'Request Altitude Change..'])).toBe(
      'Request Altitude Change..'
    )
    expect(findRequestAltitudeAction(['Request Altitude Change'])).toBe('Request Altitude Change')
    expect(findRequestAltitudeAction([' request altitude change.. '])).toBe(' request altitude change.. ')
  })

  it('finds nothing among other entries, including the other "Request" ones', () => {
    expect(findRequestAltitudeAction(['Request Direct to Fix..', 'Radio Check'])).toBeNull()
    expect(findRequestAltitudeAction([])).toBeNull()
  })
})

describe('findCancelAltitudeAction', () => {
  it('finds the old and the new cancel entry of a list that holds a level', () => {
    expect(findCancelAltitudeAction(['Cancel Altitude Change', 'FL320', 'FL340', 'Say Again'])).toBe(
      'Cancel Altitude Change'
    )
    expect(findCancelAltitudeAction(['FL290', 'FL310', 'Cancel'])).toBe('Cancel')
    expect(findCancelAltitudeAction(['10,700m', '11,300m', 'Cancel'])).toBe('Cancel')
  })

  it('finds nothing in a menu with no level, or a list with no cancel entry', () => {
    expect(findCancelAltitudeAction(['Cancel', 'Radio Check'])).toBeNull()
    expect(findCancelAltitudeAction(['FL290', 'FL310'])).toBeNull()
  })
})
