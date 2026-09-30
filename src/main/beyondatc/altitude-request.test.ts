import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BeyondAtcState, BeyondAtcTranscriptEntry } from '@shared/ipc'
import { EMPTY_STATE } from './BeyondAtcService'
import { confirmsLevel, levelLabelToFeet, pickLevelLabel, requestAltitude } from './altitude-request'

// Real Actions lists and ATC lines, captured live 2026-10-01 (Fenix A320, cleared FL380 —
// flightdeck-backend's docs/beyondatc-notes.md, "requesting a new cruise altitude").
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

/** Stands in for BeyondAtcService: replays BeyondATC's real responses to each set_action. */
class FakeBeyondAtc extends EventEmitter {
  state: BeyondAtcState = { ...EMPTY_STATE, actions: CRUISE_ACTIONS }
  transcript: BeyondAtcTranscriptEntry[] = []
  sent: string[] = []
  respond = true
  answer = (label: string): string => `Hongkong Shuttle 250, roger, new cruise altitude ${label}.`

  getState(): BeyondAtcState {
    return this.state
  }
  getTranscript(): BeyondAtcTranscriptEntry[] {
    return this.transcript
  }
  setAction(label: string): void {
    this.sent.push(label)
    if (!this.respond) return
    setTimeout(() => {
      if (label === 'Request Altitude Change') {
        this.say('player', 'Hongkong Shuttle 250, request new cruise altitude.')
        this.say('atc', 'Hongkong Shuttle 250, you broke up. Say again altitude.')
        this.setActions(LEVEL_ACTIONS)
      } else if (label === 'Cancel Altitude Change') {
        this.setActions(CRUISE_ACTIONS)
      } else {
        this.say('player', `Request ${label}, Hongkong Shuttle 250.`)
        this.say('atc', this.answer(label))
        this.setActions(CRUISE_ACTIONS)
      }
    }, 1000)
  }
  private say(speaker: BeyondAtcTranscriptEntry['speaker'], text: string): void {
    this.transcript = [...this.transcript, { speaker, text, ts: Date.now() }]
    this.emit('transcript', this.transcript)
  }
  private setActions(actions: string[]): void {
    this.state = { ...this.state, actions }
    this.emit('state', this.state)
  }
}

describe('levelLabelToFeet / pickLevelLabel / confirmsLevel', () => {
  it('reads FL labels, and metric ones in either notation', () => {
    expect(levelLabelToFeet('FL380')).toBe(38000)
    expect(levelLabelToFeet('11300m')).toBeCloseTo(37073, 0)
    expect(levelLabelToFeet('11,300 m')).toBeCloseTo(37073, 0)
    expect(levelLabelToFeet('Say Again')).toBeNull()
  })

  it('picks the offered level matching the target, or nothing', () => {
    expect(pickLevelLabel(LEVEL_ACTIONS, 36000)).toBe('FL360')
    expect(pickLevelLabel(LEVEL_ACTIONS, 40000)).toBeNull()
    // A SimBrief metric step (11,300 m) against a metric label.
    expect(pickLevelLabel(['Cancel Altitude Change', '10700m', '11300m'], 11300 / 0.3048)).toBe('11300m')
  })

  it("recognises BeyondATC's real confirmation and a plain climb", () => {
    expect(confirmsLevel('Hongkong Shuttle 250, roger, new cruise altitude FL360.', 'FL360')).toBe(true)
    expect(confirmsLevel('Hongkong Shuttle 250, climb FL360.', 'FL360')).toBe(true)
    expect(confirmsLevel('Hongkong Shuttle 250, roger, new cruise altitude FL340.', 'FL360')).toBe(false)
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

  it('reports no answer when ATC confirms a different level', async () => {
    const atc = new FakeBeyondAtc()
    atc.answer = () => 'Hongkong Shuttle 250, roger, new cruise altitude FL340.'
    const result = requestAltitude(atc, 36000)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(await result).toEqual({ outcome: 'noAnswer', label: 'FL360' })
  })
})
