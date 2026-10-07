import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { IpcChannels } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { setBeyondAtcSettings } from '../db/settings-repo'
import { FakeServiceSocket } from '../net/fake-service-socket'
import type { TrackingController } from '../tracking/TrackingController'
import { registerBeyondAtcHandlers, type BeyondAtcHandlerDeps } from './beyondatc-handlers'
import { fakeIpc } from './fake-ipc'

const sockets = FakeServiceSocket.opened

describe('BeyondATC IPC handlers', () => {
  let db: WingLogDb
  let deps: BeyondAtcHandlerDeps
  let tracking: EventEmitter & { getActive: () => undefined }
  let sim: EventEmitter
  const publish = vi.fn()

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    sockets.length = 0
    publish.mockClear()
    tracking = Object.assign(new EventEmitter(), { getActive: () => undefined })
    sim = new EventEmitter()
    deps = {
      db,
      liveHub: { publish },
      trackingController: tracking as unknown as TrackingController,
      sim: sim as unknown as BeyondAtcHandlerDeps['sim'],
      listApproaches: () => [],
      socketCtor: FakeServiceSocket
    }
  })

  it('stays off by default, answering with empty state and ignoring commands', () => {
    const { ipcMain, invoke } = fakeIpc()
    registerBeyondAtcHandlers(ipcMain, deps)
    expect(sockets).toHaveLength(0)
    expect(invoke(IpcChannels.settingsGetBeyondAtc)).toMatchObject({ enabled: false })
    expect(invoke(IpcChannels.beyondAtcGetStatus)).toEqual({ state: 'disconnected', lastError: null })
    expect(invoke(IpcChannels.beyondAtcGetState)).toEqual(EMPTY_BEYONDATC_STATE)
    expect(invoke(IpcChannels.beyondAtcGetTranscript)).toEqual([])
    expect(invoke(IpcChannels.beyondAtcGetArrival)).toBeNull()
    for (const [channel, value] of [
      [IpcChannels.beyondAtcSetAction, 'Request taxi'],
      [IpcChannels.beyondAtcSetFrequency, 121.9],
      [IpcChannels.beyondAtcSetFrequencyCom2, 118.7],
      [IpcChannels.beyondAtcSetAutoTune, true],
      [IpcChannels.beyondAtcSetAutoRespond, false]
    ] as [string, unknown][]) {
      expect(invoke(channel, value), channel).toBeUndefined()
    }
  })

  it("connects at startup when it's on, to BeyondATC's port unless e2e gives another", () => {
    setBeyondAtcSettings(db, { enabled: true, host: 'localhost' })
    registerBeyondAtcHandlers(fakeIpc().ipcMain, deps)
    registerBeyondAtcHandlers(fakeIpc().ipcMain, { ...deps, port: 50123 })
    expect(sockets.map((s) => s.url)).toEqual(['ws://localhost:41716/', 'ws://localhost:50123/'])
  })

  it('reconnects when its settings are saved, publishes its status live, and closes on quit', () => {
    const { ipcMain, invoke } = fakeIpc()
    const devDiagnostics = { attachBeyondAtc: vi.fn() }
    const beyondAtc = registerBeyondAtcHandlers(ipcMain, { ...deps, devDiagnostics })
    invoke(IpcChannels.settingsSetBeyondAtc, { enabled: true, host: '192.168.1.20' })
    expect(sockets.map((s) => s.url)).toEqual(['ws://192.168.1.20:41716/'])
    expect(devDiagnostics.attachBeyondAtc).toHaveBeenCalledTimes(1)
    sockets[0].open()
    expect(publish).toHaveBeenCalledWith('beyondAtcStatus', expect.objectContaining({ state: 'connected' }))
    expect(invoke(IpcChannels.beyondAtcGetStatus)).toMatchObject({ state: 'connected' })

    invoke(IpcChannels.settingsSetBeyondAtc, { enabled: false, host: '192.168.1.20' })
    expect(sockets[0].closed).toBe(true)
    expect(invoke(IpcChannels.beyondAtcGetStatus)).toEqual({ state: 'disconnected', lastError: null })

    invoke(IpcChannels.settingsSetBeyondAtc, { enabled: true, host: 'localhost' })
    beyondAtc.stop()
    expect(sockets[1].closed).toBe(true)
  })

  it('switches step climb on and off only for a real boolean, and feeds it telemetry', () => {
    const { ipcMain, invoke } = fakeIpc()
    registerBeyondAtcHandlers(ipcMain, deps)
    expect(invoke(IpcChannels.beyondAtcGetStepClimb)).toMatchObject({ enabled: false })
    invoke(IpcChannels.beyondAtcSetStepClimb, 'yes')
    expect(invoke(IpcChannels.beyondAtcGetStepClimb)).toMatchObject({ enabled: false })
    invoke(IpcChannels.beyondAtcSetStepClimb, true)
    expect(invoke(IpcChannels.beyondAtcGetStepClimb)).toMatchObject({ enabled: true })
    expect(() => sim.emit('telemetry', { altitudeM: 10000 })).not.toThrow()
    expect(() => tracking.emit('point', { phase: 'landing' })).not.toThrow()
  })
})
