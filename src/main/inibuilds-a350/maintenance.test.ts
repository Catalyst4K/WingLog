import { describe, expect, it } from 'vitest'
import { buildMaintenanceReport } from './maintenance'

/** Synthetic fixture matching the real `.data` shape catalogued in flightdeck-backend's
 *  docs/wasm-maintenance-notes.md (not a captured real file — CLAUDE.md's fixtures rule).
 *  Confirmed identical section/key shape across every real sample the spike found. */
const FULL_FIXTURE = [
  '[apu]',
  'apu_hours = 1565.109009',
  'apu_oil = 10.463158',
  'apu_start_cycles = 4.000000',
  '',
  '[elec]',
  'battery_1_pct = 97.234558',
  'battery_2_pct = 97.234558',
  'battery_emer1_pct = 97.234558',
  'battery_emer2_pct = 97.234558',
  '',
  '[eng]',
  'eng1_hours = 7045.364258',
  'eng1_oil_level = 18.403938',
  'eng2_hours = 7045.364258',
  'eng2_oil_level = 17.830002',
  '',
  '[hyd]',
  'hyd1_rsv = 41.691605',
  'hyd2_rsv = 32.251915'
].join('\n')

describe('buildMaintenanceReport (iniBuilds A350)', () => {
  it('builds a group per recognized section, with fields in order', () => {
    const report = buildMaintenanceReport(FULL_FIXTURE)
    expect(report.addon).toBe('inibuildsA350')
    expect(report.groups).toEqual([
      {
        key: 'apu',
        fields: [
          { key: 'apuHours', value: '1565.109009' },
          { key: 'apuOilQuantity', value: '10.463158' },
          { key: 'apuStartCycles', value: '4' }
        ]
      },
      {
        key: 'electrical',
        fields: [
          { key: 'batteryPct', index: 1, value: '97.234558' },
          { key: 'batteryPct', index: 2, value: '97.234558' },
          { key: 'batteryEmergencyPct', index: 1, value: '97.234558' },
          { key: 'batteryEmergencyPct', index: 2, value: '97.234558' }
        ]
      },
      {
        key: 'engines',
        fields: [
          { key: 'engineHours', index: 1, value: '7045.364258' },
          { key: 'oilQuantity', index: 1, value: '18.403938' },
          { key: 'engineHours', index: 2, value: '7045.364258' },
          { key: 'oilQuantity', index: 2, value: '17.830002' }
        ]
      },
      {
        key: 'hydraulics',
        fields: [
          { key: 'hydraulicsReservoir', index: 1, value: '41.691605' },
          { key: 'hydraulicsReservoir', index: 2, value: '32.251915' }
        ]
      }
    ])
  })

  it('omits a group entirely when its section is absent, without dropping the others', () => {
    const withoutApu = FULL_FIXTURE.split('\n')
      .filter((line) => !line.startsWith('[apu]') && !line.startsWith('apu_'))
      .join('\n')
    const report = buildMaintenanceReport(withoutApu)
    expect(report.groups.map((g) => g.key)).toEqual(['electrical', 'engines', 'hydraulics'])
  })

  it('returns an empty groups array for a pure-whitespace file', () => {
    expect(buildMaintenanceReport('   \n\t\n   ')).toEqual({ addon: 'inibuildsA350', groups: [] })
  })

  it('returns an empty groups array for empty input', () => {
    expect(buildMaintenanceReport('')).toEqual({ addon: 'inibuildsA350', groups: [] })
  })

  it('includes only the batteries actually present, not assuming all four', () => {
    const report = buildMaintenanceReport('[elec]\nbattery_1_pct = 50.000000')
    expect(report.groups).toEqual([{ key: 'electrical', fields: [{ key: 'batteryPct', index: 1, value: '50' }] }])
  })

  it('includes only the engine present, not assuming both', () => {
    const report = buildMaintenanceReport('[eng]\neng1_hours = 100.000000')
    expect(report.groups).toEqual([{ key: 'engines', fields: [{ key: 'engineHours', index: 1, value: '100' }] }])
  })

  it('includes engine oil without engine hours when only that key is present', () => {
    const report = buildMaintenanceReport('[eng]\neng1_oil_level = 18.403938')
    expect(report.groups).toEqual([{ key: 'engines', fields: [{ key: 'oilQuantity', index: 1, value: '18.403938' }] }])
  })

  it('includes only the hydraulic system present, not assuming both', () => {
    const report = buildMaintenanceReport('[hyd]\nhyd1_rsv = 41.691605')
    expect(report.groups).toEqual([{ key: 'hydraulics', fields: [{ key: 'hydraulicsReservoir', index: 1, value: '41.691605' }] }])
  })

  it('ignores a non-finite value rather than showing NaN', () => {
    const report = buildMaintenanceReport('[apu]\napu_hours = not-a-number')
    expect(report).toEqual({ addon: 'inibuildsA350', groups: [] })
  })
})
