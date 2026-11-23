import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appIconPath } from './app-icon-path'

describe('appIconPath', () => {
  const resources = join('app', 'resources')
  const root = join('src', 'root')

  it("is the installed app's resource for the system's setting", () => {
    expect(appIconPath(true, resources, root, false)).toBe(join(resources, 'tray-icon.png'))
    expect(appIconPath(true, resources, root, true)).toBe(join(resources, 'tray-icon-dark.png'))
  })

  it("is the build folder's picture for the system's setting when running from source", () => {
    expect(appIconPath(false, resources, root, false)).toBe(join(root, 'build', 'icon.png'))
    expect(appIconPath(false, resources, root, true)).toBe(join(root, 'build', 'icon-dark.png'))
  })

  it('finds both real pictures when running from source', () => {
    const appRoot = join(__dirname, '..', '..', '..')
    expect(existsSync(appIconPath(false, resources, appRoot, false))).toBe(true)
    expect(existsSync(appIconPath(false, resources, appRoot, true))).toBe(true)
  })
})
