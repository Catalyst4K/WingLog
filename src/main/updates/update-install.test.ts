import { describe, expect, it, vi, type Mock } from 'vitest'
import type { UpdateInstallState } from '@shared/ipc'
import { UpdateService } from './update-check'
import { canInstallInApp, UpdateInstaller, type UpdaterEngine } from './update-install'

const RELEASE = {
  tag_name: 'v1.5.0',
  html_url: 'https://github.com/Catalyst4K/WingLog/releases/tag/v1.5.0',
  body: '',
  draft: false,
  prerelease: false,
  published_at: '2026-10-20T10:00:00Z'
}

interface FakeEngine extends UpdaterEngine {
  progress: (percent: number) => void
  checkForUpdates: Mock<UpdaterEngine['checkForUpdates']>
  downloadUpdate: Mock<UpdaterEngine['downloadUpdate']>
  quitAndInstall: Mock<UpdaterEngine['quitAndInstall']>
}

function fakeEngine(found: string | null = '1.5.0'): FakeEngine {
  let listener: (progress: { percent: number }) => void = () => {}
  return {
    checkForUpdates: vi.fn(async () => (found ? { updateInfo: { version: found } } : null)),
    downloadUpdate: vi.fn(async () => ['C:/pending/WingLog-1.5.0-win-x64.exe']),
    quitAndInstall: vi.fn(),
    on: (_event, l) => {
      listener = l
      return undefined
    },
    progress: (percent) => listener({ percent })
  }
}

describe('canInstallInApp', () => {
  it('is only true for an installed Windows build that is not the dev build', () => {
    expect(canInstallInApp({ isPackaged: true, isDevBuild: false, platform: 'win32' })).toBe(true)
    expect(canInstallInApp({ isPackaged: false, isDevBuild: false, platform: 'win32' })).toBe(false)
    expect(canInstallInApp({ isPackaged: true, isDevBuild: true, platform: 'win32' })).toBe(false)
    expect(canInstallInApp({ isPackaged: true, isDevBuild: false, platform: 'darwin' })).toBe(false)
  })
})

describe('UpdateInstaller', () => {
  it('without an engine, it is unsupported and does nothing', async () => {
    const installer = new UpdateInstaller({ engine: null, isFlightActive: () => false })
    expect(installer.getState()).toEqual({ supported: false, phase: 'idle', percent: 0 })
    await installer.download('1.5.0')
    expect(installer.getState().phase).toBe('idle')
    expect(installer.installAndRestart()).toBe('notReady')
  })

  it('downloads the version the check found, reporting progress, and ends ready', async () => {
    const engine = fakeEngine()
    const installer = new UpdateInstaller({ engine, isFlightActive: () => false })
    const states: UpdateInstallState[] = []
    installer.on('state', (s) => states.push(s))
    engine.downloadUpdate.mockImplementation(async () => {
      engine.progress(37.6)
      engine.progress(Number.NaN)
      engine.progress(250)
      return ['x']
    })

    await installer.download('1.5.0')

    expect(states.map((s) => [s.phase, s.percent])).toEqual([
      ['downloading', 0],
      ['downloading', 38],
      ['downloading', 0],
      ['downloading', 100],
      ['ready', 100]
    ])
    expect(installer.getState()).toEqual({ supported: true, phase: 'ready', percent: 100 })
  })

  it('refuses a download when the updater finds a different version from the check', async () => {
    const engine = fakeEngine('1.5.1')
    const log = vi.fn()
    const installer = new UpdateInstaller({ engine, isFlightActive: () => false, log })
    await installer.download('1.5.0')
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect(installer.getState().phase).toBe('error')
    expect(log).toHaveBeenCalledWith('download failed: the updater found 1.5.1, expected 1.5.0')
  })

  it('treats an updater that finds nothing, or throws, as a failed download that can be retried', async () => {
    const engine = fakeEngine(null)
    const log = vi.fn()
    const installer = new UpdateInstaller({ engine, isFlightActive: () => false, log })
    await installer.download('1.5.0')
    expect(installer.getState().phase).toBe('error')
    expect(log).toHaveBeenCalledWith('download failed: the updater found nothing, expected 1.5.0')

    engine.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.5.0' } })
    engine.downloadUpdate.mockRejectedValue('net::ERR_INTERNET_DISCONNECTED')
    await installer.download('1.5.0')
    expect(installer.getState().phase).toBe('error')
    expect(log).toHaveBeenLastCalledWith('download failed: net::ERR_INTERNET_DISCONNECTED')

    engine.downloadUpdate.mockResolvedValue(['x'])
    await installer.download('1.5.0')
    expect(installer.getState().phase).toBe('ready')
  })

  it('does not start a second download while one is running or finished', async () => {
    const engine = fakeEngine()
    const installer = new UpdateInstaller({ engine, isFlightActive: () => false })
    const first = installer.download('1.5.0')
    await installer.download('1.5.0')
    await first
    await installer.download('1.5.0')
    expect(engine.downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('installs and restarts only when the download is ready and no flight is being tracked', async () => {
    const engine = fakeEngine()
    let flying = true
    const installer = new UpdateInstaller({ engine, isFlightActive: () => flying })

    expect(installer.installAndRestart()).toBe('notReady')
    await installer.download('1.5.0')
    expect(installer.installAndRestart()).toBe('flightActive')
    expect(engine.quitAndInstall).not.toHaveBeenCalled()

    flying = false
    expect(installer.installAndRestart()).toBe('started')
    // Silent install, then WingLog starts again on its own.
    expect(engine.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('ignores progress that arrives when nothing is downloading', () => {
    const engine = fakeEngine()
    const installer = new UpdateInstaller({ engine, isFlightActive: () => false })
    engine.progress(50)
    expect(installer.getState().percent).toBe(0)
  })
})

describe('UpdateService with the installer', () => {
  function service(engine: UpdaterEngine | null, flying = false): UpdateService {
    return new UpdateService({
      currentVersion: '1.4.1',
      isEnabled: () => true,
      getSkippedVersion: () => null,
      setSkippedVersion: () => {},
      installer: new UpdateInstaller({ engine, isFlightActive: () => flying }),
      fetchImpl: (async () =>
        new Response(JSON.stringify(RELEASE), { status: 200 })) as unknown as typeof fetch,
      log: () => {}
    })
  }

  it('puts the install state in the status, and emits it as the download moves', async () => {
    const engine = fakeEngine()
    const s = service(engine)
    expect(s.getStatus().install).toEqual({ supported: true, phase: 'idle', percent: 0 })
    const phases: string[] = []
    s.on('status', (status) => phases.push(status.install.phase))

    await s.checkNow()
    await s.startDownload()

    expect(phases).toEqual(['idle', 'idle', 'downloading', 'ready'])
    expect(engine.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(s.restartToUpdate()).toBe('started')
  })

  it('downloads nothing until the check has found a newer release', async () => {
    const engine = fakeEngine()
    const s = service(engine)
    await s.startDownload()
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
  })

  it('reports an unsupported install without an installer, and refuses to restart', async () => {
    const s = new UpdateService({
      currentVersion: '1.4.1',
      isEnabled: () => true,
      getSkippedVersion: () => null,
      setSkippedVersion: () => {},
      log: () => {}
    })
    expect(s.getStatus().install).toEqual({ supported: false, phase: 'idle', percent: 0 })
    await s.startDownload()
    expect(s.restartToUpdate()).toBe('notReady')
  })

  it('never restarts during a flight', async () => {
    const s = service(fakeEngine(), true)
    await s.checkNow()
    await s.startDownload()
    expect(s.restartToUpdate()).toBe('flightActive')
  })
})
