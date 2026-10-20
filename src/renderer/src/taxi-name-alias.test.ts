import type { NavdataTaxiSegment } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { aliasSplitTaxiways } from './taxi-name-alias'

const seg = (name: string | null, at = 0): NavdataTaxiSegment => ({
  startLat: at,
  startLon: 0,
  endLat: at,
  endLon: 1,
  name,
  startHoldShort: false,
  endHoldShort: false
})
const names = (segments: NavdataTaxiSegment[]): (string | null)[] => segments.map((s) => s.name)

describe('aliasSplitTaxiways', () => {
  it('names a missing taxiway from its numbered pieces (ZUCK has M1 to M4 and no M)', () => {
    const out = aliasSplitTaxiways([seg('M1'), seg('M2'), seg('G'), seg('M4'), seg(null)], ['M', 'G', 'H1'])
    expect(names(out)).toEqual(['M', 'M', 'G', 'M', null])
  })

  it('leaves the network alone when every cleared taxiway exists', () => {
    const segments = [seg('M'), seg('M1'), seg('G')]
    expect(aliasSplitTaxiways(segments, ['M', 'G'])).toBe(segments)
  })

  it('leaves it alone when nothing is named like the missing taxiway', () => {
    const segments = [seg('G'), seg('A1')]
    expect(aliasSplitTaxiways(segments, ['M', 'G'])).toBe(segments)
  })

  it('does not rename a piece the clearance names itself, or a name that only starts the same', () => {
    const out = aliasSplitTaxiways([seg('M1'), seg('M2'), seg('MA'), seg('M12B'), seg('M')], ['M', 'M1'])
    // "M" exists, so nothing is missing and nothing changes.
    expect(names(out)).toEqual(['M1', 'M2', 'MA', 'M12B', 'M'])
    const missing = aliasSplitTaxiways([seg('M1'), seg('M2'), seg('MA'), seg('M12B')], ['M', 'M1'])
    expect(names(missing)).toEqual(['M1', 'M', 'MA', 'M12B'])
  })

  it('leaves separate stubs that only share a prefix for the pathfinder', () => {
    const stubs = [seg('M1', 0), seg('M2', 5), seg('G', 9)]
    expect(aliasSplitTaxiways(stubs, ['M', 'G'])).toBe(stubs)
  })

  it('names pieces that join end to end', () => {
    const chain = [
      { ...seg('M1'), endLon: 1 },
      { ...seg('M2'), startLon: 1, endLon: 2 }
    ]
    expect(names(aliasSplitTaxiways(chain, ['M']))).toEqual(['M', 'M'])
  })
})
