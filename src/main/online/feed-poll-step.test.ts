import { describe, expect, it } from 'vitest'
import {
  FEED_FLOOR_MS,
  initialPollState,
  pollFinished,
  STATUS_INTERVAL_MS,
  stepPoll,
  TRAFFIC_INTERVAL_MS,
  type PollInput,
  type PollState
} from './feed-poll-step'

const T0 = 1_000_000

function input(changes: Partial<PollInput> = {}): PollInput {
  return { nowMs: T0, network: 'vatsim', wanted: 'traffic', ...changes }
}

/** Starts a request at `nowMs` and returns the state with it in flight. */
function started(state: PollState, changes: Partial<PollInput> = {}): PollState {
  const step = stepPoll(state, input(changes))
  expect(step.fetchNow).toBe(true)
  return step.state
}

describe('stepPoll', () => {
  it('fetches at once when something first wants the feed', () => {
    const step = stepPoll(initialPollState(), input())
    expect(step.fetchNow).toBe(true)
    expect(step.state).toMatchObject({ network: 'vatsim', inFlight: true, lastStartMs: T0 })
  })

  it('fetches nothing with no network chosen, or with nothing wanting the feed', () => {
    expect(stepPoll(initialPollState(), input({ network: null })).fetchNow).toBe(false)
    const none = stepPoll(initialPollState(), input({ wanted: 'none' }))
    expect(none.fetchNow).toBe(false)
    expect(none.wakeAtMs).toBeNull()
  })

  it('never makes two requests at once', () => {
    const inFlight = started(initialPollState())
    const later = stepPoll(inFlight, input({ nowMs: T0 + 10 * TRAFFIC_INTERVAL_MS }))
    expect(later.fetchNow).toBe(false)
  })

  it('waits the 15 s interval for traffic, and says when to look again', () => {
    const done = pollFinished(started(initialPollState()), true, T0 + 400)
    const early = stepPoll(done, input({ nowMs: T0 + 5000 }))
    expect(early.fetchNow).toBe(false)
    expect(early.wakeAtMs).toBe(T0 + TRAFFIC_INTERVAL_MS)
    expect(stepPoll(done, input({ nowMs: T0 + TRAFFIC_INTERVAL_MS - 1 })).fetchNow).toBe(false)
    expect(stepPoll(done, input({ nowMs: T0 + TRAFFIC_INTERVAL_MS })).fetchNow).toBe(true)
  })

  it('counts the interval from when a request started, not when it ended', () => {
    const done = pollFinished(started(initialPollState()), true, T0 + 9000)
    expect(stepPoll(done, input({ nowMs: T0 + TRAFFIC_INTERVAL_MS })).fetchNow).toBe(true)
  })

  it('waits 60 s for the status interval', () => {
    const done = pollFinished(started(initialPollState(), { wanted: 'status' }), true, T0 + 300)
    expect(stepPoll(done, input({ nowMs: T0 + STATUS_INTERVAL_MS - 1, wanted: 'status' })).fetchNow).toBe(
      false
    )
    expect(stepPoll(done, input({ nowMs: T0 + STATUS_INTERVAL_MS, wanted: 'status' })).fetchNow).toBe(true)
  })

  it('moves to the shorter interval as soon as traffic is wanted, but never under the 15 s floor', () => {
    const done = pollFinished(started(initialPollState(), { wanted: 'status' }), true, T0 + 300)
    expect(stepPoll(done, input({ nowMs: T0 + 5000, wanted: 'traffic' })).fetchNow).toBe(false)
    expect(stepPoll(done, input({ nowMs: T0 + FEED_FLOOR_MS, wanted: 'traffic' })).fetchNow).toBe(true)
  })

  it.each(['vatsim', 'ivao'] as const)('holds the 15 s floor for %s however often it is asked', (network) => {
    let state = pollFinished(started(initialPollState(), { network }), true, T0 + 100)
    for (let ms = 1; ms < FEED_FLOOR_MS; ms += 997) {
      const step = stepPoll(state, input({ network, nowMs: T0 + ms }))
      expect(step.fetchNow).toBe(false)
      state = step.state
    }
  })

  it('restarts after a pause with nothing wanted: at once if the last start was 15 s ago or more', () => {
    const done = pollFinished(started(initialPollState()), true, T0 + 400)
    const paused = stepPoll(done, input({ nowMs: T0 + 60_000, wanted: 'none' })).state
    expect(stepPoll(paused, input({ nowMs: T0 + 61_000 })).fetchNow).toBe(true)
  })

  it('does not restart at once if the last start was under 15 s ago', () => {
    const done = pollFinished(started(initialPollState()), true, T0 + 400)
    const paused = stepPoll(done, input({ nowMs: T0 + 2000, wanted: 'none' })).state
    const step = stepPoll(paused, input({ nowMs: T0 + 3000 }))
    expect(step.fetchNow).toBe(false)
    expect(step.wakeAtMs).toBe(T0 + FEED_FLOOR_MS)
  })

  describe('a change of network', () => {
    it('forgets failures and any request in flight, so the new feed starts clean', () => {
      let state = started(initialPollState())
      state = pollFinished(state, false, T0 + 500)
      state = stepPoll(state, input({ nowMs: T0 + 40_000, network: 'ivao' })).state
      expect(state).toMatchObject({ network: 'ivao', failures: 0, retryAtMs: null, inFlight: true })
    })

    it('still keeps 15 s between starts, so switching back and forth cannot beat the floor', () => {
      const first = started(initialPollState(), { network: 'ivao' })
      const switched = stepPoll(first, input({ nowMs: T0 + 2000, network: 'vatsim' }))
      expect(switched.fetchNow).toBe(false)
      expect(switched.wakeAtMs).toBe(T0 + FEED_FLOOR_MS)
      const back = stepPoll(switched.state, input({ nowMs: T0 + 4000, network: 'ivao' }))
      expect(back.fetchNow).toBe(false)
    })
  })

  describe('after a failure', () => {
    it('waits 30, 60, 120, 240 and then 300 s, and 300 s for every later one', () => {
      let state = started(initialPollState())
      let at = T0
      for (const waitS of [30, 60, 120, 240, 300, 300, 300]) {
        state = pollFinished(state, false, at + 500)
        const early = stepPoll(state, input({ nowMs: at + 500 + waitS * 1000 - 1 }))
        expect(early.fetchNow).toBe(false)
        expect(early.wakeAtMs).toBe(at + 500 + waitS * 1000)
        at = at + 500 + waitS * 1000
        state = started(state, { nowMs: at })
      }
    })

    it('goes back to the normal interval after a success', () => {
      let state = pollFinished(started(initialPollState()), false, T0 + 500)
      state = started(state, { nowMs: T0 + 31_000 })
      state = pollFinished(state, true, T0 + 31_300)
      expect(state).toMatchObject({ failures: 0, retryAtMs: null })
      expect(stepPoll(state, input({ nowMs: T0 + 31_000 + TRAFFIC_INTERVAL_MS })).fetchNow).toBe(true)
    })

    it('still waits out the back-off when the interval has passed', () => {
      const state = pollFinished(started(initialPollState()), false, T0 + 500)
      expect(stepPoll(state, input({ nowMs: T0 + TRAFFIC_INTERVAL_MS * 2 - 1000 })).fetchNow).toBe(false)
    })
  })

  describe('a one-off read for the ATIS', () => {
    it('reads at once when nothing has been read, and only once at a time', () => {
      const state = started(initialPollState(), { wanted: 'once' })
      expect(state).toMatchObject({ inFlight: true, lastStartMs: T0 })
      expect(stepPoll(state, input({ wanted: 'once', nowMs: T0 + 1 })).fetchNow).toBe(false)
    })

    it('waits for the 15 s floor after the last read, whatever read it was', () => {
      for (const earlier of ['traffic', 'status'] as const) {
        const done = pollFinished(started(initialPollState(), { wanted: earlier }), true, T0 + 400)
        const early = stepPoll(done, input({ wanted: 'once', nowMs: T0 + 14_999 }))
        expect(early.fetchNow).toBe(false)
        expect(early.wakeAtMs).toBe(T0 + FEED_FLOOR_MS)
        expect(stepPoll(done, input({ wanted: 'once', nowMs: T0 + FEED_FLOOR_MS })).fetchNow).toBe(true)
      }
    })

    it('does not wait out the 60 s status interval: it is read as soon as the floor allows', () => {
      const done = pollFinished(started(initialPollState(), { wanted: 'status' }), true, T0 + 400)
      expect(stepPoll(done, input({ wanted: 'status', nowMs: T0 + FEED_FLOOR_MS })).fetchNow).toBe(false)
      expect(stepPoll(done, input({ wanted: 'once', nowMs: T0 + FEED_FLOOR_MS })).fetchNow).toBe(true)
    })

    it('holds to the back-off after a failure', () => {
      const failed = pollFinished(started(initialPollState(), { wanted: 'once' }), false, T0 + 500)
      const step = stepPoll(failed, input({ wanted: 'once', nowMs: T0 + 20_000 }))
      expect(step.fetchNow).toBe(false)
      expect(step.wakeAtMs).toBe(T0 + 500 + 30_000)
    })

    it('reads nothing with no network chosen', () => {
      expect(stepPoll(initialPollState(), input({ wanted: 'once', network: null })).fetchNow).toBe(false)
    })
  })
})
