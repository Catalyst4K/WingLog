import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { trayIconPath } from './tray-icon-path'

describe('trayIconPath', () => {
  it("is the installed app's resource, or the build folder's icon from source", () => {
    expect(trayIconPath(true, join('app', 'resources'), join('src', 'root'))).toBe(
      join('app', 'resources', 'tray-icon.png')
    )
    expect(trayIconPath(false, join('app', 'resources'), join('src', 'root'))).toBe(
      join('src', 'root', 'build', 'icon.png')
    )
  })
})
