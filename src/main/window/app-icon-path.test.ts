import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appIconPath } from './app-icon-path'

describe('appIconPath', () => {
  const resources = join('app', 'resources')
  const root = join('src', 'root')

  it("is the installed app's .ico on Windows, for the system's setting", () => {
    expect(appIconPath(true, resources, root, false, 'win32')).toBe(join(resources, 'app-icon.ico'))
    expect(appIconPath(true, resources, root, true, 'win32')).toBe(join(resources, 'app-icon-dark.ico'))
  })

  it("is the installed app's PNG elsewhere", () => {
    expect(appIconPath(true, resources, root, false, 'darwin')).toBe(join(resources, 'tray-icon.png'))
    expect(appIconPath(true, resources, root, true, 'linux')).toBe(join(resources, 'tray-icon-dark.png'))
  })

  it('is the build folder’s picture when running from source', () => {
    expect(appIconPath(false, resources, root, false, 'win32')).toBe(join(root, 'build', 'icon.ico'))
    expect(appIconPath(false, resources, root, true, 'win32')).toBe(join(root, 'build', 'icon-dark.ico'))
    expect(appIconPath(false, resources, root, false, 'darwin')).toBe(join(root, 'build', 'icon.png'))
    expect(appIconPath(false, resources, root, true, 'darwin')).toBe(join(root, 'build', 'icon-dark.png'))
  })

  it('finds every real picture when running from source', () => {
    const appRoot = join(__dirname, '..', '..', '..')
    for (const platform of ['win32', 'darwin'] as const) {
      for (const isDark of [false, true]) {
        expect(existsSync(appIconPath(false, resources, appRoot, isDark, platform))).toBe(true)
      }
    }
  })
})
