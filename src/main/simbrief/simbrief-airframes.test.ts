import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      // Real collision case (docs/simbrief-notes.md, 2026-09-08): same developer and
      // engines as the entry above, so today's label formula alone can't tell them apart —
      // only the "(SL)" in the comment does.
      {
        airframe_id: 1730058463659,
        pilot_id: 80,
        airframe_internal_id: '80_1730058463659',
        airframe_comments: 'Fenix Simulations (MSFS) - A320 CFM (SL)',
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
      },
      // A real PMDG-shaped case (docs/simbrief-notes.md): the distinguishing text has no
      // leading type code at all, just a bracketed credit suffix to strip.
      {
        airframe_id: 1761165451022,
        pilot_id: 746599,
        airframe_internal_id: '746599_1761165451022',
        airframe_comments: 'PMDG (MSFS) - Dual Class [credit: PMDG Official]',
        airframe_engines: 'CFM56-7B26',
        airframe_registration: 'N738PM'
      },
      // A byte-for-byte duplicate of the entry above (same developer/variant/engines) —
      // exercises the defensive dedup pass, decision 3.
      {
        airframe_id: 1761165999999,
        pilot_id: 746599,
        airframe_internal_id: '746599_1761165999999',
        airframe_comments: 'PMDG (MSFS) - Dual Class [credit: PMDG Official]',
        airframe_engines: 'CFM56-7B26',
        airframe_registration: 'N738PM'
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
    // 1 default + Fenix CFM + Fenix CFM (SL) + Fenix IAE + PMDG Dual Class (its exact
    // duplicate collapsed away) — the X-Plane ToLiss entry excluded entirely.
    expect(options).toHaveLength(5)
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

  // docs/simbrief-notes.md, "Why near-identical community airframes collapse to the same
  // label" — the real distinguishing text was already being fetched, just discarded.
  it('extracts a variant, stripping the redundant leading type code', () => {
    const options = parseAirframesForType(FIXTURE, 'A320')
    const noSl = options.find((o) => o.comments === 'Fenix Simulations (MSFS) - A320 CFM')
    const withSl = options.find((o) => o.comments === 'Fenix Simulations (MSFS) - A320 CFM (SL)')
    // Fenix + A320-family classic: the no-tag entry gets Wing Fence made explicit
    // (Callum's own domain knowledge, 2026-09-08) rather than staying blank.
    expect(noSl?.variant).toBe('CFM (WF)')
    expect(withSl?.variant).toBe('CFM (SL)')
  })

  it('does not infer Wing Fence for a developer other than Fenix, even on A320-family', () => {
    const fixtureOtherDeveloper: RawAirframesResponse = {
      A320: {
        aircraft_icao: 'A320',
        airframes: [
          {
            airframe_id: 1,
            pilot_id: 1,
            airframe_internal_id: '1_1',
            airframe_comments: 'Some Other Dev (MSFS) - Basic Livery',
            airframe_engines: 'CFM56-5B4/P',
            airframe_registration: ''
          }
        ]
      }
    }
    const [option] = parseAirframesForType(fixtureOtherDeveloper, 'A320')
    expect(option.variant).toBe('Basic Livery')
  })

  it('does not infer Wing Fence on an A320 neo (no such option exists)', () => {
    const fixtureNeo: RawAirframesResponse = {
      A20N: {
        aircraft_icao: 'A20N',
        airframes: [
          {
            airframe_id: 1,
            pilot_id: 1,
            airframe_internal_id: '1_1',
            airframe_comments: 'Fenix Simulations (MSFS) - A20N CFM',
            airframe_engines: 'LEAP-1A26',
            airframe_registration: ''
          }
        ]
      }
    }
    const [option] = parseAirframesForType(fixtureNeo, 'A20N')
    expect(option.variant).toBe('CFM')
  })

  it('does not strip a type-like prefix with no following space (e.g. A339X)', () => {
    const fixtureWithGluedPrefix: RawAirframesResponse = {
      A339: {
        aircraft_icao: 'A339',
        airframes: [
          {
            airframe_id: 1,
            pilot_id: 1,
            airframe_internal_id: '1_1',
            airframe_comments: 'Headwind Simulations (MSFS) - A339X ACJ',
            airframe_engines: 'TRENT 7000-72',
            airframe_registration: ''
          }
        ]
      }
    }
    const [option] = parseAirframesForType(fixtureWithGluedPrefix, 'A339')
    expect(option.variant).toBe('A339X ACJ')
  })

  it('strips a trailing [credit: ...] suffix from the variant, keeping it in comments', () => {
    const options = parseAirframesForType(FIXTURE, 'A320')
    const pmdg = options.find((o) => o.developer === 'PMDG')
    expect(pmdg?.variant).toBe('Dual Class')
    expect(pmdg?.comments).toBe('PMDG (MSFS) - Dual Class [credit: PMDG Official]')
  })

  it('collapses an exact duplicate (same developer, variant and engines) to one entry', () => {
    const options = parseAirframesForType(FIXTURE, 'A320')
    const pmdgEntries = options.filter((o) => o.developer === 'PMDG')
    expect(pmdgEntries).toHaveLength(1)
  })

  it('is null when the parsed remainder is empty after stripping the type prefix', () => {
    const fixtureBareType: RawAirframesResponse = {
      B738: {
        aircraft_icao: 'B738',
        airframes: [
          {
            airframe_id: 1,
            pilot_id: 1,
            airframe_internal_id: '1_1',
            airframe_comments: 'Some Dev (MSFS) - B738',
            airframe_engines: 'CFM56-7B',
            airframe_registration: ''
          }
        ]
      }
    }
    const [option] = parseAirframesForType(fixtureBareType, 'B738')
    expect(option.variant).toBeNull()
  })
})

describe('fetchAirframesForType', () => {
  // fetchAirframesData caches its in-flight/resolved promise at module scope for the
  // process lifetime (deliberately — see the file's own comment) — reset modules between
  // tests so each one observes a fresh, uncached fetch.
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses a successful response for the requested type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(FIXTURE)
      })
    )
    const { fetchAirframesForType } = await import('./simbrief-airframes')

    const options = await fetchAirframesForType('A320')

    expect(options.some((o) => o.isDefault)).toBe(true)
  })

  it('returns an empty list for a type the response does not contain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(FIXTURE) })
    )
    const { fetchAirframesForType } = await import('./simbrief-airframes')

    expect(await fetchAirframesForType('B788')).toEqual([])
  })

  it('returns an empty list when the response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const { fetchAirframesForType } = await import('./simbrief-airframes')

    expect(await fetchAirframesForType('A320')).toEqual([])
  })

  it('returns an empty list when the fetch itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const { fetchAirframesForType } = await import('./simbrief-airframes')

    expect(await fetchAirframesForType('A320')).toEqual([])
  })

  it('only fetches once for repeated calls within the same process (cached)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(FIXTURE) })
    vi.stubGlobal('fetch', fetchMock)
    const { fetchAirframesForType } = await import('./simbrief-airframes')

    await fetchAirframesForType('A320')
    await fetchAirframesForType('B738')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
