import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { pointRegeditAtUnpackedScripts } from './regedit-scripts'

describe('pointRegeditAtUnpackedScripts', () => {
  it("points node-simconnect's regedit at the scripts unpacked from app.asar", () => {
    const setExternalVBSLocation = vi.fn(() => 'Folder found and set')
    const load = vi.fn(() => ({ setExternalVBSLocation }))

    expect(pointRegeditAtUnpackedScripts(true, 'C:/WingLog/resources', load)).toBe('Folder found and set')
    expect(load).toHaveBeenCalledWith('regedit')
    expect(setExternalVBSLocation).toHaveBeenCalledWith(
      join('C:/WingLog/resources', 'app.asar.unpacked', 'node_modules', 'regedit', 'vbs')
    )
  })

  it('leaves regedit alone in development, where its scripts are ordinary files', () => {
    const load = vi.fn()
    expect(pointRegeditAtUnpackedScripts(false, 'unused', load)).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  it("loads the same regedit node-simconnect requires (resolved from node-simconnect's location)", () => {
    // The real default loader: regedit is only reachable as node-simconnect's dependency.
    const result = pointRegeditAtUnpackedScripts(true, join(__dirname, 'no-such-resources'))
    expect(result).toBe('Folder not found')
  })
})
