import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { IpcChannels, type CaptureKeepState } from '@shared/ipc'
import { MAX_LINE_CHARS } from '../diagnostics/diag'
import { fakeIpc } from './fake-ipc'
import { registerDiagnosticsHandlers, registerSimHandlers, type SimStatusSource } from './sim-handlers'

describe('sim IPC handlers', () => {
  it("publishes the sim's telemetry and status live, and answers the status for the first render", () => {
    const sim = Object.assign(new EventEmitter(), { getStatus: () => ({ state: 'connected' }) })
    const publish = vi.fn()
    const { ipcMain, invoke } = fakeIpc()
    registerSimHandlers(ipcMain, { sim: sim as unknown as SimStatusSource, liveHub: { publish } })
    sim.emit('telemetry', { latitude: 22.3 })
    sim.emit('status', { state: 'disconnected' })
    expect(publish.mock.calls).toEqual([
      ['simTelemetry', { latitude: 22.3 }],
      ['simConnectionStatus', { state: 'disconnected' }]
    ])
    expect(invoke(IpcChannels.simConnectionStatusGet)).toEqual({ state: 'connected' })
  })
})

describe('diagnostics IPC handlers', () => {
  it("writes the renderer's diag.log lines, capped, and drops malformed ones", () => {
    const diag = vi.fn()
    const { ipcMain, invoke } = fakeIpc()
    registerDiagnosticsHandlers(ipcMain, { diag })
    invoke(IpcChannels.diagLog, 'map', 'x'.repeat(MAX_LINE_CHARS + 50))
    invoke(IpcChannels.diagLog, 'not-a-category', 'hello')
    invoke(IpcChannels.diagLog, 'map', { message: 'hello' })
    expect(diag).toHaveBeenCalledTimes(1)
    expect(diag).toHaveBeenCalledWith('map', 'x'.repeat(MAX_LINE_CHARS))
  })

  it("keeps a flight's capture in the dev build, and answers 'none' outside it", () => {
    const { ipcMain, invoke } = fakeIpc()
    registerDiagnosticsHandlers(ipcMain, { diag: vi.fn() })
    expect(invoke(IpcChannels.captureKeepState, 7)).toBe('none')
    expect(invoke(IpcChannels.captureKeep, 7)).toBe('none')

    const flightCapture = {
      keepState: vi.fn((): CaptureKeepState => 'auto'),
      keep: vi.fn((): CaptureKeepState => 'kept')
    }
    const dev = fakeIpc()
    registerDiagnosticsHandlers(dev.ipcMain, { diag: vi.fn(), flightCapture })
    expect(dev.invoke(IpcChannels.captureKeepState, 7)).toBe('auto')
    expect(dev.invoke(IpcChannels.captureKeep, 7)).toBe('kept')
    expect(dev.invoke(IpcChannels.captureKeep, '../7')).toBe('none')
    expect(flightCapture.keep).toHaveBeenCalledTimes(1)
  })
})
