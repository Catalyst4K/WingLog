/**
 * connectSim picks the live sim or a replayed capture from the e2e environment variables, and
 * says which of the replay's streams to hand on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', on: vi.fn() },
  ipcMain: { handle: vi.fn() }
}))
const replayCapture = vi.fn()
vi.mock('./sim/replay-capture', () => ({ replayCapture: (...args: unknown[]) => replayCapture(...args) }))

import { connectSim } from './sim-and-tracking'
import { SimConnectService } from './sim/SimConnectService'

const ENV_NAMES = [
  'WINGLOG_E2E_FIXTURE',
  'WINGLOG_E2E_REPLAY_MODE',
  'WINGLOG_E2E_REPLAY_SPEED',
  'WINGLOG_E2E_REPLAY_HOLD',
  'WINGLOG_E2E_REPLAY_GAP_S',
  'WINGLOG_E2E_REPLAY_STREAMS'
]

afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name]
  replayCapture.mockReset()
})

describe('connectSim', () => {
  it('uses the live sim connection when no fixture is set', () => {
    const { sim, replayStreams } = connectSim()
    expect(sim).toBeInstanceOf(SimConnectService)
    expect(replayStreams).toBeUndefined()
    expect(replayCapture).not.toHaveBeenCalled()
  })

  it('replays the fixture with the options from the environment, handing on no streams by default', () => {
    const replay = { sim: { replayed: true } }
    replayCapture.mockReturnValue(replay)
    process.env.WINGLOG_E2E_FIXTURE = 'flight.ndjson'
    process.env.WINGLOG_E2E_REPLAY_SPEED = '4'
    process.env.WINGLOG_E2E_REPLAY_HOLD = '1'

    const result = connectSim()

    expect(result.sim).toBe(replay.sim)
    expect(result.replayStreams).toBeUndefined()
    expect(replayCapture).toHaveBeenCalledWith(
      'flight.ndjson',
      expect.objectContaining({ mode: 'paced', speedMultiplier: 4, holdUntilReleased: true })
    )
  })

  it.each(['1', 'beyondatc'])(
    'hands on the replayed streams when WINGLOG_E2E_REPLAY_STREAMS is %s',
    (value) => {
      const replay = { sim: {} }
      replayCapture.mockReturnValue(replay)
      process.env.WINGLOG_E2E_FIXTURE = 'flight.ndjson'
      process.env.WINGLOG_E2E_REPLAY_STREAMS = value

      expect(connectSim().replayStreams).toBe(replay)
    }
  )
})
