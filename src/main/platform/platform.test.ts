import { describe, expect, it } from 'vitest'
import { canHostSim, currentPlatform, quitsWhenAllWindowsClose } from './platform'
import { gsxReceiptsDefaultPath, userDataDirectory } from './paths'

describe('currentPlatform', () => {
  it('knows Windows and macOS, and treats every other Unix as Linux', () => {
    expect(currentPlatform('win32')).toBe('win32')
    expect(currentPlatform('darwin')).toBe('darwin')
    expect(currentPlatform('linux')).toBe('linux')
    expect(currentPlatform('freebsd')).toBe('linux')
  })

  it("defaults to this machine's", () => {
    expect(['win32', 'darwin', 'linux']).toContain(currentPlatform())
  })
})

describe('canHostSim', () => {
  it('is true only on Windows, where MSFS, GSX and BeyondATC run', () => {
    expect(canHostSim('win32')).toBe(true)
    expect(canHostSim('darwin')).toBe(false)
    expect(canHostSim('linux')).toBe(false)
  })
})

describe('quitsWhenAllWindowsClose', () => {
  it('is false on macOS only, which keeps the app running with no window', () => {
    expect(quitsWhenAllWindowsClose('win32')).toBe(true)
    expect(quitsWhenAllWindowsClose('linux')).toBe(true)
    expect(quitsWhenAllWindowsClose('darwin')).toBe(false)
  })
})

describe('userDataDirectory', () => {
  it("is each OS's own per-user folder, built with that OS's separators, whatever OS runs the test", () => {
    expect(
      userDataDirectory('win32', { APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' }, 'C:\\Users\\Test')
    ).toBe('C:\\Users\\Test\\AppData\\Roaming\\WingLog')
    expect(userDataDirectory('darwin', {}, '/Users/test')).toBe(
      '/Users/test/Library/Application Support/WingLog'
    )
    expect(userDataDirectory('linux', {}, '/home/test')).toBe('/home/test/.config/WingLog')
  })

  it('follows XDG_CONFIG_HOME on Linux when it is set', () => {
    expect(userDataDirectory('linux', { XDG_CONFIG_HOME: '/data/config' }, '/home/test')).toBe(
      '/data/config/WingLog'
    )
    expect(userDataDirectory('linux', { XDG_CONFIG_HOME: '' }, '/home/test')).toBe(
      '/home/test/.config/WingLog'
    )
  })

  it('has no answer on Windows without APPDATA', () => {
    expect(userDataDirectory('win32', {}, 'C:\\Users\\Test')).toBeNull()
  })
})

describe('gsxReceiptsDefaultPath', () => {
  it('builds the GSX receipts path from APPDATA on Windows, with Windows separators on any OS', () => {
    expect(gsxReceiptsDefaultPath('win32', { APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' })).toBe(
      'C:\\Users\\Test\\AppData\\Roaming\\Virtuali\\GSX\\Receipts'
    )
  })

  it('is null off Windows, and on Windows without APPDATA', () => {
    expect(gsxReceiptsDefaultPath('darwin', { APPDATA: 'x' })).toBeNull()
    expect(gsxReceiptsDefaultPath('linux', {})).toBeNull()
    expect(gsxReceiptsDefaultPath('win32', {})).toBeNull()
  })
})
