import { describe, expect, it } from 'vitest'
import { buildMaintenanceReport } from './maintenance'

/** Synthetic fixture matching the real `.hours` shape catalogued in flightdeck-backend's
 *  docs/wasm-maintenance-notes.md — not a captured real file (CLAUDE.md's fixtures rule). */
const FULL_FIXTURE = [
  '[Engines]',
  'OilQ_Last.0=1854',
  'OilQ_Last.1=1740',
  '',
  '[Wheels]',
  'Wheel Assy State.0=2',
  'Wheel Assy State.1=0',
  'Nose Wheel Assy State.0=1',
  '',
  '[Hydraulics]',
  'Volume Sys.0=12.503669',
  'Temp Sys.0=515.000000',
  '',
  '[Fuel]',
  'Tank 0 Volume=10300.000000',
  'Tank 0 Temperature=515.000000',
  '',
  '[Failure Groups]',
  'Active=1',
  'Run Timer.0=236.499863',
  '',
  '[Failure Items]',
  'Run Timer.0=236.499863 43917384.000000',
  'Run Timer.1=236.499863 47480112.000000'
].join('\n')

describe('buildMaintenanceReport', () => {
  it('builds a group per recognized section, with fields in order', () => {
    const report = buildMaintenanceReport(FULL_FIXTURE)
    expect(report.addon).toBe('pmdg777')
    expect(report.groups).toEqual([
      {
        key: 'engines',
        fields: [
          { key: 'oilQuantity', index: 1, value: '1854' },
          { key: 'oilQuantity', index: 2, value: '1740' }
        ]
      },
      {
        key: 'wheels',
        fields: [
          { key: 'wheelMain', index: 1, value: '2' },
          { key: 'wheelMain', index: 2, value: '0' },
          { key: 'wheelNose', index: 1, value: '1' }
        ]
      },
      {
        key: 'hydraulics',
        fields: [
          { key: 'hydraulicsVolume', index: 1, value: '12.503669' },
          { key: 'hydraulicsTemp', index: 1, value: '515' }
        ]
      },
      {
        key: 'fuel',
        fields: [
          { key: 'fuelVolume', index: 1, value: '10300' },
          { key: 'fuelTemperature', index: 1, value: '515' }
        ]
      }
    ])
  })

  it('never surfaces Failure Groups/Failure Items fields', () => {
    const report = buildMaintenanceReport(FULL_FIXTURE)
    const allKeys = report.groups.map((g) => g.key)
    expect(allKeys).not.toContain('failureGroups')
    expect(allKeys).not.toContain('failureItems')
    const anyRunTimer = report.groups.some((g) => g.fields.some((f) => f.key.toLowerCase().includes('runtimer')))
    expect(anyRunTimer).toBe(false)
  })

  it('omits a group entirely when its section is absent, without dropping the others', () => {
    const withoutEngines = FULL_FIXTURE.split('\n')
      .filter((line) => !line.startsWith('[Engines]') && !line.startsWith('OilQ_Last'))
      .join('\n')
    const report = buildMaintenanceReport(withoutEngines)
    expect(report.groups.map((g) => g.key)).toEqual(['wheels', 'hydraulics', 'fuel'])
  })

  it('returns an empty groups array for a pure-whitespace file (a real sampled tail had one)', () => {
    expect(buildMaintenanceReport('   \n\t\n   ')).toEqual({ addon: 'pmdg777', groups: [] })
  })

  it('returns an empty groups array for empty input', () => {
    expect(buildMaintenanceReport('')).toEqual({ addon: 'pmdg777', groups: [] })
  })

  it('omits the Engines group when OilQ_Last is present on only one engine', () => {
    const report = buildMaintenanceReport('[Engines]\nOilQ_Last.0=1854')
    expect(report.groups).toEqual([{ key: 'engines', fields: [{ key: 'oilQuantity', index: 1, value: '1854' }] }])
  })
})
