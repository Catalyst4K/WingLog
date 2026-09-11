import { afterEach, describe, expect, it } from 'vitest'
import { defaultGsxReceiptsPath } from './default-path'

describe('defaultGsxReceiptsPath', () => {
  const originalPlatform = process.platform
  const originalAppData = process.env.APPDATA

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.env.APPDATA = originalAppData
  })

  it('returns null on a non-Windows platform', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(defaultGsxReceiptsPath()).toBeNull()
  })

  it('returns null on Windows when APPDATA is not set', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    delete process.env.APPDATA
    expect(defaultGsxReceiptsPath()).toBeNull()
  })

  it('builds the GSX receipts path from APPDATA on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.APPDATA = 'C:\\Users\\Test\\AppData\\Roaming'
    expect(defaultGsxReceiptsPath()).toBe('C:\\Users\\Test\\AppData\\Roaming\\Virtuali\\GSX\\Receipts')
  })
})
