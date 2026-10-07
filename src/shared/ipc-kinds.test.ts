import { describe, expect, it } from 'vitest'
import { IpcChannels } from './ipc-channels'
import { channelKind } from './ipc-kinds'

const keys = Object.keys(IpcChannels) as (keyof typeof IpcChannels)[]

describe('channelKind', () => {
  it('gives every channel exactly one kind, and all four kinds are used', () => {
    const counts = { live: 0, command: 0, query: 0, local: 0 }
    for (const key of keys) counts[channelKind(key)]++
    expect(counts.live + counts.command + counts.query + counts.local).toBe(keys.length)
    for (const n of Object.values(counts)) expect(n).toBeGreaterThan(0)
  })

  it('classes the main-to-renderer pushes as live', () => {
    for (const key of [
      'simTelemetry',
      'trackingPoint',
      'gsxRemoteStatus',
      'beyondAtcState',
      'updatesStatus'
    ] as const) {
      expect(channelKind(key)).toBe('live')
    }
  })

  it('classes the remote-safe BeyondATC and GSX Remote actions as commands', () => {
    for (const key of [
      'beyondAtcSetAction',
      'beyondAtcSetStepClimb',
      'gsxRemotePickMenu',
      'gsxRemoteRunCommand'
    ] as const) {
      expect(channelKind(key)).toBe('command')
    }
  })

  it('classes file dialogs and pages opened outside the app as local, and the database reads as queries', () => {
    expect(channelKind('gsxBrowseFolder')).toBe('local')
    expect(channelKind('dispatchOpenOfpPdf')).toBe('local')
    expect(channelKind('aircraftList')).toBe('query')
    expect(channelKind('settingsGetTheme')).toBe('query')
  })
})
