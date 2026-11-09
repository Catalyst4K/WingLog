import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { IpcChannels } from '@shared/ipc'
import { createDb, type WingLogDb } from '../db/client'
import { stageRoutine } from '@shared/gsx-routines'
import { getSetting, setGsxRemoteSettings, setSetting } from '../db/settings-repo'
import { listHiddenBuiltIns, listOwnRoutines } from '../db/gsx-routine-repo'
import { EMPTY_COMMAND_BAR, EMPTY_MENU } from '../gsx-remote/GsxRemoteService'
import { FakeServiceSocket } from '../net/fake-service-socket'
import { fakeIpc } from './fake-ipc'
import { registerGsxRemoteHandlers } from './gsx-remote-handlers'

const sockets = FakeServiceSocket.opened

describe('GSX Remote IPC handlers', () => {
  let db: WingLogDb
  const publish = vi.fn()

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    sockets.length = 0
    publish.mockClear()
  })

  it('hands back the GSX Remote command table, for a second screen', () => {
    const { commands } = registerGsxRemoteHandlers(fakeIpc().ipcMain, {
      db,
      liveHub: { publish },
      socketCtor: FakeServiceSocket
    })
    expect(Object.keys(commands).sort()).toEqual([
      'gsx.cancelPrompt',
      'gsx.cancelRoutine',
      'gsx.pickMenu',
      'gsx.runCommand',
      'gsx.search',
      'gsx.startRoutine',
      'gsx.submitPrompt',
      'gsx.toggleMenu'
    ])
  })

  it('stays off by default, answering with empty state and ignoring commands', () => {
    const { ipcMain, invoke } = fakeIpc()
    registerGsxRemoteHandlers(ipcMain, { db, liveHub: { publish }, socketCtor: FakeServiceSocket })
    expect(sockets).toHaveLength(0)
    expect(invoke(IpcChannels.settingsGetGsxRemote)).toMatchObject({ enabled: false })
    expect(invoke(IpcChannels.gsxRemoteGetStatus)).toEqual({ state: 'disconnected', lastError: null })
    expect(invoke(IpcChannels.gsxRemoteGetServices)).toEqual([])
    expect(invoke(IpcChannels.gsxRemoteGetGateInfo)).toBeNull()
    expect(invoke(IpcChannels.gsxRemoteGetMenu)).toEqual(EMPTY_MENU)
    expect(invoke(IpcChannels.gsxRemoteGetPrompt)).toBeNull()
    expect(invoke(IpcChannels.gsxRemoteGetCommandBar)).toEqual(EMPTY_COMMAND_BAR)
    expect(invoke(IpcChannels.gsxRoutineGet)).toBeNull()
    for (const [channel, ...args] of [
      [IpcChannels.gsxRemotePickMenu, 0],
      [IpcChannels.gsxRemoteSearch, 'fuel'],
      [IpcChannels.gsxRemoteToggleMenu],
      [IpcChannels.gsxRemoteSubmitPrompt, 1, '120'],
      [IpcChannels.gsxRemoteCancelPrompt, 1],
      [IpcChannels.gsxRemoteRunCommand, 'boarding'],
      [IpcChannels.gsxRoutineStart, 'builtin-arrival'],
      [IpcChannels.gsxRoutineCancel]
    ] as [string, ...unknown[]][]) {
      expect(invoke(channel, ...args), channel).toBeUndefined()
    }
  })

  it("connects at startup when it's on, on GSX's default port unless one is set", () => {
    setGsxRemoteSettings(db, { enabled: true, host: 'localhost', port: null })
    registerGsxRemoteHandlers(fakeIpc().ipcMain, { db, liveHub: { publish }, socketCtor: FakeServiceSocket })
    setGsxRemoteSettings(db, { enabled: true, host: '192.168.1.20', port: 8750 })
    registerGsxRemoteHandlers(fakeIpc().ipcMain, { db, liveHub: { publish }, socketCtor: FakeServiceSocket })
    expect(sockets.map((s) => s.url)).toEqual(['ws://localhost:8744/', 'ws://192.168.1.20:8750/'])
  })

  it('reconnects when its settings are saved, publishes its status live, and closes on quit', () => {
    const { ipcMain, invoke } = fakeIpc()
    const devDiagnostics = { attachGsx: vi.fn() }
    const remote = registerGsxRemoteHandlers(ipcMain, {
      db,
      liveHub: { publish },
      devDiagnostics,
      socketCtor: FakeServiceSocket
    })
    invoke(IpcChannels.settingsSetGsxRemote, { enabled: true, host: 'localhost', port: 8744 })
    expect(sockets.map((s) => s.url)).toEqual(['ws://localhost:8744/'])
    expect(devDiagnostics.attachGsx).toHaveBeenCalledTimes(1)
    sockets[0].open()
    expect(publish).toHaveBeenCalledWith('gsxRemoteStatus', expect.objectContaining({ state: 'connected' }))
    expect(invoke(IpcChannels.gsxRemoteGetStatus)).toMatchObject({ state: 'connected' })

    invoke(IpcChannels.settingsSetGsxRemote, { enabled: true, host: 'localhost', port: 8745 })
    expect(sockets[0].closed).toBe(true)
    expect(sockets[1].url).toBe('ws://localhost:8745/')

    remote.stop()
    expect(sockets[1].closed).toBe(true)
  })
})

const MY_ROUTINE = {
  id: 'my-routine',
  name: 'My routine',
  stages: stageRoutine(['Cleaning', 'Catering']),
  answerGsxChoice: true,
  fuel: 'simbrief-block'
}

describe('GSX routines IPC', () => {
  let db: WingLogDb
  const publish = vi.fn()

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    sockets.length = 0
    publish.mockClear()
  })

  describe('the routines list, save and delete', () => {
    function register(): ReturnType<typeof fakeIpc>['invoke'] {
      const { ipcMain, invoke } = fakeIpc()
      registerGsxRemoteHandlers(ipcMain, { db, liveHub: { publish }, socketCtor: FakeServiceSocket })
      return invoke
    }

    it('lists the three built-ins first', () => {
      const routines = register()(IpcChannels.gsxRoutinesList) as { id: string }[]
      expect(routines.map((r) => r.id)).toEqual([
        'builtin-fenix-departure',
        'builtin-arrival',
        'builtin-turnaround-clean'
      ])
    })

    it('saves a routine and lists it after the built-ins, replacing it when saved again', () => {
      const invoke = register()
      const saved = invoke(IpcChannels.gsxRoutinesSave, MY_ROUTINE) as {
        ok: boolean
        routines: { id: string }[]
      }
      expect(saved.ok).toBe(true)
      expect(saved.routines.map((r) => r.id)).toEqual([
        'builtin-fenix-departure',
        'builtin-arrival',
        'builtin-turnaround-clean',
        'my-routine'
      ])
      const again = invoke(IpcChannels.gsxRoutinesSave, { ...MY_ROUTINE, name: 'Renamed' }) as {
        routines: { id: string; name: string }[]
      }
      expect(again.routines.filter((r) => r.id === 'my-routine')).toEqual([
        expect.objectContaining({ name: 'Renamed' })
      ])
      expect(again.routines).toHaveLength(4)
    })

    it('keeps a saved routine across a restart', () => {
      register()(IpcChannels.gsxRoutinesSave, MY_ROUTINE)
      const routines = register()(IpcChannels.gsxRoutinesList) as { id: string }[]
      expect(routines.map((r) => r.id)).toContain('my-routine')
    })

    it.each([
      ['a blank name', { ...MY_ROUTINE, name: '  ' }],
      [
        'a service that is not offered',
        { ...MY_ROUTINE, stages: [{ services: ['Departure'], startsWhen: [] }] }
      ],
      ['something that is not a routine', 'x']
    ])('refuses %s, and stores nothing', (_label, routine) => {
      const result = register()(IpcChannels.gsxRoutinesSave, routine) as { ok: boolean; reason: string }
      expect(result.ok).toBe(false)
      expect(result.reason).not.toBe('')
      expect(getSetting(db, 'gsxRoutines')).toBeUndefined()
    })

    it('refuses a new routine once there are fifty, but still saves a change to one of them', () => {
      const invoke = register()
      for (let i = 0; i < 50; i++) invoke(IpcChannels.gsxRoutinesSave, { ...MY_ROUTINE, id: 'r-' + i })
      const refused = invoke(IpcChannels.gsxRoutinesSave, { ...MY_ROUTINE, id: 'one-too-many' }) as {
        ok: boolean
      }
      expect(refused.ok).toBe(false)
      const changed = invoke(IpcChannels.gsxRoutinesSave, { ...MY_ROUTINE, id: 'r-3', name: 'Changed' }) as {
        ok: boolean
      }
      expect(changed.ok).toBe(true)
    })

    it('deletes one of the pilot’s own routines', () => {
      const invoke = register()
      invoke(IpcChannels.gsxRoutinesSave, MY_ROUTINE)
      const afterOwn = invoke(IpcChannels.gsxRoutinesDelete, 'my-routine') as { id: string }[]
      expect(afterOwn.map((r) => r.id)).not.toContain('my-routine')
      expect(afterOwn).toHaveLength(3)
    })

    it('deletes a built-in routine from the list, keeps the pilot’s own, and remembers it across a restart', () => {
      const invoke = register()
      invoke(IpcChannels.gsxRoutinesSave, MY_ROUTINE)
      const after = invoke(IpcChannels.gsxRoutinesDelete, 'builtin-arrival') as { id: string }[]
      expect(after.map((r) => r.id)).toEqual([
        'builtin-fenix-departure',
        'builtin-turnaround-clean',
        'my-routine'
      ])
      const again = register()(IpcChannels.gsxRoutinesList) as { id: string }[]
      expect(again.map((r) => r.id)).toEqual([
        'builtin-fenix-departure',
        'builtin-turnaround-clean',
        'my-routine'
      ])
    })

    it('keeps the pilot’s version of an example in the example’s place, and deleting the example drops that version too', () => {
      const invoke = register()
      const saved = invoke(IpcChannels.gsxRoutinesSave, {
        ...MY_ROUTINE,
        id: 'builtin-arrival',
        name: 'My arrival'
      }) as { routines: { id: string; name: string }[] }
      expect(saved.routines.map((r) => [r.id, r.name])).toEqual([
        ['builtin-fenix-departure', 'Departure'],
        ['builtin-arrival', 'My arrival'],
        ['builtin-turnaround-clean', 'Turnaround clean']
      ])
      expect(listOwnRoutines(db).routines.map((r) => r.name)).toEqual(['My arrival'])
      const after = invoke(IpcChannels.gsxRoutinesDelete, 'builtin-arrival') as { id: string }[]
      expect(after.map((r) => r.id)).toEqual(['builtin-fenix-departure', 'builtin-turnaround-clean'])
      expect(listOwnRoutines(db).routines).toEqual([])
    })

    it('deleting the same built-in twice, or an id it does not know, changes nothing more', () => {
      const invoke = register()
      invoke(IpcChannels.gsxRoutinesDelete, 'builtin-arrival')
      invoke(IpcChannels.gsxRoutinesDelete, 'builtin-arrival')
      const after = invoke(IpcChannels.gsxRoutinesDelete, 'no-such-routine') as { id: string }[]
      expect(after).toHaveLength(2)
      expect(listHiddenBuiltIns(db)).toEqual(['builtin-arrival'])
    })

    it('still leaves a deleted built-in out when a routine is saved afterwards', () => {
      const invoke = register()
      invoke(IpcChannels.gsxRoutinesDelete, 'builtin-arrival')
      const saved = invoke(IpcChannels.gsxRoutinesSave, MY_ROUTINE) as { routines: { id: string }[] }
      expect(saved.routines.map((r) => r.id)).toEqual([
        'builtin-fenix-departure',
        'builtin-turnaround-clean',
        'my-routine'
      ])
    })

    it('lists the built-ins when the stored routines are damaged', () => {
      setSetting(db, 'gsxRoutines', '{broken')
      expect((register()(IpcChannels.gsxRoutinesList) as unknown[]).length).toBe(3)
    })
  })

  describe('running a routine', () => {
    const SERVICES = ['Deboarding', 'Catering', 'Refueling', 'Boarding', 'Departure', 'GPU'].map((id) => ({
      id,
      displayName: id,
      state: 'available',
      stateText: '',
      icon: id.toLowerCase(),
      canTrigger: true,
      canBypass: false,
      statusText: '',
      progressText: ''
    }))
    const TOGGLE = JSON.stringify({ type: 'command', verb: 'menu.toggle' })

    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    function connected(): { invoke: ReturnType<typeof fakeIpc>['invoke']; stop: () => void } {
      setGsxRemoteSettings(db, { enabled: true, host: 'localhost', port: 8744 })
      const { ipcMain, invoke } = fakeIpc()
      const remote = registerGsxRemoteHandlers(ipcMain, {
        db,
        liveHub: { publish },
        socketCtor: FakeServiceSocket,
        telemetry: () => undefined,
        plannedZfwKg: () => 191_000
      })
      sockets[0].open()
      sockets[0].receive({
        v: 1,
        type: 'snapshot',
        ts: 1,
        services: SERVICES,
        menu: { entries: [] },
        menuShown: false
      })
      return { invoke, stop: remote.stop }
    }

    it('starts a routine by its id, opens the menu, and publishes how it is going', () => {
      const { invoke, stop } = connected()
      invoke(IpcChannels.gsxRoutineStart, 'builtin-fenix-departure')
      expect(sockets[0].sent).toContain(TOGGLE)
      expect(publish).toHaveBeenCalledWith(
        'gsxRoutine',
        expect.objectContaining({ routineId: 'builtin-fenix-departure', state: 'running' })
      )
      expect(invoke(IpcChannels.gsxRoutineGet)).toMatchObject({ routineName: 'Departure' })
      stop()
    })

    it('runs one of the pilot’s own routines', () => {
      const { invoke, stop } = connected()
      invoke(IpcChannels.gsxRoutinesSave, { ...MY_ROUTINE, stages: stageRoutine(['GPU']) })
      invoke(IpcChannels.gsxRoutineStart, 'my-routine')
      expect(invoke(IpcChannels.gsxRoutineGet)).toMatchObject({ routineName: 'My routine' })
      stop()
    })

    it('does not start a built-in the pilot has deleted', () => {
      const { invoke, stop } = connected()
      invoke(IpcChannels.gsxRoutinesDelete, 'builtin-fenix-departure')
      invoke(IpcChannels.gsxRoutineStart, 'builtin-fenix-departure')
      expect(invoke(IpcChannels.gsxRoutineGet)).toBeNull()
      stop()
    })

    it('ignores an id it does not know, and one that is not text', () => {
      const { invoke, stop } = connected()
      invoke(IpcChannels.gsxRoutineStart, 'no-such-routine')
      invoke(IpcChannels.gsxRoutineStart, { id: 'builtin-arrival' })
      expect(invoke(IpcChannels.gsxRoutineGet)).toBeNull()
      expect(sockets[0].sent).not.toContain(TOGGLE)
      stop()
    })

    it('cancels the running routine, and the screens drop it at once', () => {
      const { invoke, stop } = connected()
      invoke(IpcChannels.gsxRoutineStart, 'builtin-fenix-departure')
      invoke(IpcChannels.gsxRoutineCancel)
      expect(publish).toHaveBeenCalledWith(
        'gsxRoutine',
        expect.objectContaining({ state: 'stopped', note: { code: 'stopped', reason: 'cancelled' } })
      )
      expect(publish).toHaveBeenLastCalledWith('gsxRoutine', null)
      expect(invoke(IpcChannels.gsxRoutineGet)).toBeNull()
      stop()
    })

    it('stops a running routine when GSX Remote’s settings change, and clears the screens', () => {
      const { invoke, stop } = connected()
      invoke(IpcChannels.gsxRoutineStart, 'builtin-fenix-departure')
      invoke(IpcChannels.settingsSetGsxRemote, { enabled: true, host: 'localhost', port: 8745 })
      expect(publish).toHaveBeenCalledWith('gsxRoutine', null)
      expect(invoke(IpcChannels.gsxRoutineGet)).toBeNull()
      stop()
    })

    it('stops the routine when the app quits', () => {
      const { invoke, stop } = connected()
      invoke(IpcChannels.gsxRoutineStart, 'builtin-fenix-departure')
      stop()
      expect(publish).toHaveBeenLastCalledWith('gsxRoutine', null)
    })
  })
})
