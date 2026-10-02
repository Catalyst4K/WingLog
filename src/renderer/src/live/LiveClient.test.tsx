import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveCommand, LiveCommands, LiveTopic } from '@shared/live'
import type { WingLogApi } from '@shared/ipc'
import { LiveClientContext, electronLiveClient, useLiveTopic, type LiveClient } from './LiveClient'

const SUBSCRIBERS: Record<LiveTopic, keyof WingLogApi> = {
  simTelemetry: 'onSimTelemetry',
  simConnectionStatus: 'onSimConnectionStatus',
  trackingPoint: 'onTrackingPoint',
  trackingPointsUpdated: 'onTrackingPointsUpdated',
  gsxRemoteStatus: 'onGsxRemoteStatus',
  gsxRemoteServices: 'onGsxRemoteServices',
  gsxRemoteGate: 'onGsxRemoteGate',
  gsxRemoteMenu: 'onGsxRemoteMenu',
  gsxRemotePrompt: 'onGsxRemotePrompt',
  gsxRemoteCommandBar: 'onGsxRemoteCommandBar',
  beyondAtcStatus: 'onBeyondAtcStatus',
  beyondAtcState: 'onBeyondAtcState',
  beyondAtcTranscript: 'onBeyondAtcTranscript',
  beyondAtcStepClimb: 'onBeyondAtcStepClimb'
}

const COMMANDS: { [C in LiveCommand]: [keyof WingLogApi, LiveCommands[C]] } = {
  'atc.setAction': ['beyondAtcSetAction', ['Request Taxi']],
  'atc.setFrequency': ['beyondAtcSetFrequency', ['121.7']],
  'atc.setFrequencyCom2': ['beyondAtcSetFrequencyCom2', ['122.800']],
  'atc.setAutoTune': ['beyondAtcSetAutoTune', [true]],
  'atc.setAutoRespond': ['beyondAtcSetAutoRespond', [false]],
  'atc.setStepClimb': ['beyondAtcSetStepClimb', [true]],
  'gsx.pickMenu': ['gsxRemotePickMenu', [1]],
  'gsx.search': ['gsxRemoteSearch', ['N32']],
  'gsx.toggleMenu': ['gsxRemoteToggleMenu', []],
  'gsx.submitPrompt': ['gsxRemoteSubmitPrompt', [3, '12000']],
  'gsx.cancelPrompt': ['gsxRemoteCancelPrompt', [3]],
  'gsx.runCommand': ['gsxRemoteRunCommand', ['RELOAD_SIMBRIEF']]
}

function mockWinglog(): Record<string, ReturnType<typeof vi.fn>> {
  const api: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const name of Object.values(SUBSCRIBERS)) api[name] = vi.fn().mockReturnValue(() => {})
  for (const [name] of Object.values(COMMANDS)) api[name] = vi.fn().mockResolvedValue(undefined)
  api.beyondAtcGetStatus = vi.fn().mockResolvedValue({ state: 'connected', lastError: null })
  window.winglog = api as unknown as WingLogApi
  return api
}

describe('electronLiveClient (live-data-seam.md, part C)', () => {
  it('subscribes each topic through its own preload listener', () => {
    const api = mockWinglog()
    for (const [topic, name] of Object.entries(SUBSCRIBERS)) {
      const listener = vi.fn()
      electronLiveClient.subscribe(topic as LiveTopic, listener)
      expect(api[name]).toHaveBeenCalledWith(listener)
    }
  })

  it('sends every command to the matching preload call with its arguments', async () => {
    const api = mockWinglog()
    for (const [command, [name, args]] of Object.entries(COMMANDS)) {
      await (electronLiveClient.command as (c: string, ...a: unknown[]) => Promise<void>)(command, ...args)
      expect(api[name]).toHaveBeenCalledWith(...args)
    }
  })

  it('reads a current value where one exists, and nothing for pure streams', async () => {
    mockWinglog()
    expect(await electronLiveClient.get('beyondAtcStatus')).toEqual({ state: 'connected', lastError: null })
    expect(await electronLiveClient.get('simTelemetry')).toBeUndefined()
    expect(await electronLiveClient.get('trackingPoint')).toBeUndefined()
  })
})

describe('useLiveTopic', () => {
  function Status(): React.JSX.Element {
    const status = useLiveTopic('beyondAtcStatus', { state: 'disconnected', lastError: null })
    return <p>{status.state}</p>
  }

  it('starts from the initial value, takes the current one, then follows pushes, from any client (a LAN client later)', async () => {
    let push: (s: { state: 'connected' | 'connecting' | 'disconnected'; lastError: string | null }) => void = () => {}
    const client: LiveClient = {
      get: vi.fn().mockResolvedValue({ state: 'connecting', lastError: null }),
      subscribe: vi.fn((_topic, listener) => {
        push = listener as typeof push
        return () => {}
      }) as LiveClient['subscribe'],
      command: vi.fn()
    }
    render(
      <LiveClientContext.Provider value={client}>
        <Status />
      </LiveClientContext.Provider>
    )
    expect(await screen.findByText('connecting')).toBeInTheDocument()
    act(() => push({ state: 'connected', lastError: null }))
    expect(screen.getByText('connected')).toBeInTheDocument()
  })

  it('keeps the initial value if the current-value fetch fails', async () => {
    const client: LiveClient = {
      get: vi.fn().mockRejectedValue(new Error('not connected')),
      subscribe: vi.fn().mockReturnValue(() => {}) as LiveClient['subscribe'],
      command: vi.fn()
    }
    render(
      <LiveClientContext.Provider value={client}>
        <Status />
      </LiveClientContext.Provider>
    )
    await act(async () => {})
    expect(screen.getByText('disconnected')).toBeInTheDocument()
  })
})
