import { describe, expect, it } from 'vitest'
import { parseAirframesForType, type RawAirframesResponse } from './simbrief-airframes'

// Shaped like a real trimmed slice of inputs.airframes.json — the A320 fixture mirrors
// real rows captured 2026-09-07 (docs/plans/simbrief-airframe-picker.md): the stock
// default, two MSFS community entries with the usual "Developer (Platform) - variant"
// comment shape, an X-Plane entry that must be filtered out, and a niche type with no
// real payware addon (no dev/platform structure at all) to exercise the fallback.
const FIXTURE: RawAirframesResponse = {
  A320: {
    aircraft_icao: 'A320',
    airframes: [
      {
        airframe_id: false,
        pilot_id: false,
        airframe_internal_id: 'A320',
        airframe_comments: 'Default',
        airframe_engines: 'CFM56-5B4/P',
        airframe_registration: ''
      },
      {
        airframe_id: 1709125568637,
        pilot_id: 80,
        airframe_internal_id: '80_1709125568637',
        airframe_comments: 'Fenix Simulations (MSFS) - A320 CFM',
        airframe_engines: 'CFM56-5B4/P',
        airframe_registration: 'G-FENX'
      },
      {
        airframe_id: 1707996202186,
        pilot_id: 80,
        airframe_internal_id: '80_1707996202186',
        airframe_comments: 'Fenix Simulations (MSFS) - A320 IAE',
        airframe_engines: 'IAE V2527-A5',
        airframe_registration: 'G-FENX'
      },
      {
        airframe_id: 12345,
        pilot_id: 99,
        airframe_internal_id: '99_12345',
        airframe_comments: 'ToLiss (X-Plane) - CFM56-5B4 [credit: Rodeo314]',
        airframe_engines: 'CFM56-5B4',
        airframe_registration: ''
      }
    ]
  },
  C130: {
    aircraft_icao: 'C130',
    airframes: [
      {
        airframe_id: false,
        pilot_id: false,
        airframe_internal_id: 'C130',
        airframe_comments: 'Default',
        airframe_engines: 'T56-A-15',
        airframe_registration: ''
      },
      {
        airframe_id: 555,
        pilot_id: 12,
        airframe_internal_id: '12_555',
        airframe_comments: 'Lockheed C-130K Hercules [credit: KevinAviationHD]',
        airframe_engines: 'T56-A-15',
        airframe_registration: ''
      }
    ]
  }
}

describe('parseAirframesForType', () => {
  it('returns empty for a type not present in the data', () => {
    expect(parseAirframesForType(FIXTURE, 'ZZZZ')).toEqual([])
  })

  it('includes the stock default plus MSFS community entries, filtering out X-Plane', () => {
    const options = parseAirframesForType(FIXTURE, 'A320')
    expect(options).toHaveLength(3)
    expect(options.some((o) => o.comments.includes('ToLiss'))).toBe(false)
  })

  it('marks the stock default correctly, with no share link and no developer', () => {
    const [stock] = parseAirframesForType(FIXTURE, 'A320')
    expect(stock.isDefault).toBe(true)
    expect(stock.shareUrl).toBeNull()
    expect(stock.developer).toBeNull()
    expect(stock.simbriefType).toBe('A320')
  })

  it('parses developer from a real community comment, and builds its share link', () => {
    const options = parseAirframesForType(FIXTURE, 'A320')
    const fenixCfm = options.find((o) => o.comments === 'Fenix Simulations (MSFS) - A320 CFM')
    expect(fenixCfm?.developer).toBe('Fenix Simulations')
    expect(fenixCfm?.engines).toBe('CFM56-5B4/P')
    expect(fenixCfm?.registration).toBe('G-FENX')
    expect(fenixCfm?.isDefault).toBe(false)
    expect(fenixCfm?.shareUrl).toBe('https://dispatch.simbrief.com/airframes/share/80_1709125568637')
  })

  it('distinguishes two engine variants from the same developer', () => {
    const options = parseAirframesForType(FIXTURE, 'A320')
    const cfm = options.find((o) => o.comments.endsWith('CFM'))
    const iae = options.find((o) => o.comments.endsWith('IAE'))
    expect(cfm?.engines).toBe('CFM56-5B4/P')
    expect(iae?.engines).toBe('IAE V2527-A5')
  })

  it('falls back to a null developer for a comment with no dev/platform structure', () => {
    const options = parseAirframesForType(FIXTURE, 'C130')
    const hercules = options.find((o) => o.comments.includes('Hercules'))
    expect(hercules?.developer).toBeNull()
    expect(hercules?.comments).toBe('Lockheed C-130K Hercules [credit: KevinAviationHD]')
    // Still a real, usable share link — the fallback is only for the display label.
    expect(hercules?.shareUrl).toBe('https://dispatch.simbrief.com/airframes/share/12_555')
  })

  it('returns an empty registration as null, not an empty string', () => {
    const options = parseAirframesForType(FIXTURE, 'C130')
    expect(options.every((o) => o.registration === null)).toBe(true)
  })
})
