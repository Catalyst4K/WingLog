import { describe, expect, it, vi } from 'vitest'
import type { NavdataStand } from '@shared/ipc'
import { recordParkedStand } from './parked-stand'

const N32: NavdataStand = {
  name: 'N32',
  number: 32,
  suffix: 0,
  headingDeg: 161,
  lat: 22.31414534384843,
  lon: 113.92862486374908
}
const STOPPED_AT_N32 = { lat: 22.31404, lon: 113.92867 }

function deps(arrIcao: string | null, stands: NavdataStand[] = [N32]) {
  return {
    getArrivalIcao: vi.fn(() => arrIcao),
    getStands: vi.fn(async () => stands),
    setParkedStand: vi.fn()
  }
}

describe('recordParkedStand', () => {
  it('records the arrival stand the aircraft finished at (the real YBBN-VHHH flight, N32)', async () => {
    const d = deps('VHHH')
    expect(await recordParkedStand(d, 225, STOPPED_AT_N32)).toBe('N32')
    expect(d.getStands).toHaveBeenCalledWith('VHHH')
    expect(d.setParkedStand).toHaveBeenCalledWith(225, 'VHHH', 'N32')
  })

  it('records nothing away from any stand, with no position, or with no real arrival airport', async () => {
    const away = deps('VHHH')
    expect(await recordParkedStand(away, 1, { lat: 22.3, lon: 113.9 })).toBeNull()
    expect(away.setParkedStand).not.toHaveBeenCalled()

    expect(await recordParkedStand(deps('VHHH'), 1, null)).toBeNull()
    for (const icao of [null, 'ZZZZ']) {
      const d = deps(icao)
      expect(await recordParkedStand(d, 1, STOPPED_AT_N32)).toBeNull()
      expect(d.getStands).not.toHaveBeenCalled()
    }
  })
})
