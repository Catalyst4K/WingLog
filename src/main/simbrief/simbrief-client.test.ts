import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchLatestOfp, parseStepClimbs } from './simbrief-client'

// Minimal fixture using the real field names/shape verified against a live SimBrief OFP
// response (see docs note in simbrief-client.ts) — not real personal flight data.
function fixture(units: 'kgs' | 'lbs'): unknown {
  return {
    fetch: { status: 'Success' },
    params: { request_id: '12345', units },
    origin: { icao_code: 'EGLL' },
    destination: { icao_code: 'VHHH' },
    alternate: { icao_code: 'VMMC' },
    general: {
      icao_airline: 'BAW',
      flight_number: '31',
      route: 'BPK7F BPK DCT',
      initial_altitude: '33000',
      costindex: '85'
    },
    aircraft: { icaocode: 'A35K', reg: 'G-XWBS', internal_id: 'A35K', is_custom: '0' },
    weights: { pax_count: '328', cargo: '8200', est_zfw: '189112', est_tow: '273642', est_ldw: '198861' },
    fuel: { plan_ramp: '85029' },
    times: { sched_out: '1787860800', sched_in: '1787898900' },
    navlog: {
      fix: [
        { ident: 'BPK', altitude_feet: '4000', distance: '5' },
        { ident: 'VHHH', altitude_feet: '0', distance: '20' }
      ]
    }
  }
}

describe('fetchLatestOfp', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses a kgs-profile OFP with no unit conversion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => fixture('kgs') }))
    )

    const ofp = await fetchLatestOfp('LandingHangar711')

    expect(ofp.ofpId).toBe('12345')
    expect(ofp.aircraftIcaoType).toBe('A35K')
    expect(ofp.aircraftRegistration).toBe('G-XWBS')
    expect(ofp.flightNumber).toBe('BAW31')
    expect(ofp.depIcao).toBe('EGLL')
    expect(ofp.arrIcao).toBe('VHHH')
    expect(ofp.altnIcao).toBe('VMMC')
    expect(ofp.cruiseAltM).toBeCloseTo(33000 * 0.3048, 3)
    expect(ofp.schedOutUtc).toBe(new Date(1787860800 * 1000).toISOString())
    expect(ofp.fuelPlannedKg).toBe(85029)
    expect(ofp.pax).toBe(328)
    expect(ofp.cargoKg).toBe(8200)
    expect(ofp.zfwKg).toBe(189112)
    expect(ofp.towKg).toBe(273642)
    expect(ofp.ldwKg).toBe(198861)
    expect(ofp.costIndex).toBe(85)
    expect(ofp.simbriefIsCustom).toBe(false)
    expect(ofp.simbriefInternalId).toBe('A35K')
    expect(ofp.waypoints).toEqual([
      { ident: 'BPK', altitudeFt: 4000, distanceNm: 5 },
      { ident: 'VHHH', altitudeFt: 0, distanceNm: 20 }
    ])
    expect(ofp.stepClimbs).toEqual([])
  })

  it('surfaces step climbs from a real stepclimb_string, converting a metric level to feet', async () => {
    const withStepClimbs = fixture('kgs') as { general: Record<string, unknown> }
    withStepClimbs.general.stepclimb_string = 'EGLL/0330/DENAK/0350/SUDAR/0370/KAMUD/1130/OMBON/1190'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => withStepClimbs }))
    )

    const ofp = await fetchLatestOfp('LandingHangar711')

    expect(ofp.stepClimbs).toHaveLength(5)
    expect(ofp.stepClimbs[0]).toEqual({ atIdent: 'EGLL', toAltitudeFt: 33000, native: { unit: 'ft', value: 33000 } })
    expect(ofp.stepClimbs[2]).toEqual({ atIdent: 'SUDAR', toAltitudeFt: 37000, native: { unit: 'ft', value: 37000 } })
    expect(ofp.stepClimbs[3].atIdent).toBe('KAMUD')
    expect(ofp.stepClimbs[3].native).toEqual({ unit: 'm', value: 11300 })
    expect(ofp.stepClimbs[3].toAltitudeFt).toBeCloseTo(11300 / 0.3048, 1)
  })

  it('reads a sub-1000 metric step climb correctly end to end, cross-referencing the navlog', async () => {
    // Real reported bug, 2026-09-06: 8,900 m coded "0890" was read as FL890 (89,000 ft)
    // because 890 < 1000. Confirm the fix by wiring a matching navlog fix through
    // fetchLatestOfp itself, not just calling parseStepClimbs directly.
    const withMetricStep = fixture('kgs') as { general: Record<string, unknown>; navlog: { fix: unknown[] } }
    withMetricStep.general.stepclimb_string = 'DUTUB/0890'
    withMetricStep.navlog.fix.push({ ident: 'DUTUB', altitude_feet: String(8900 / 0.3048), distance: '400' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => withMetricStep }))
    )

    const ofp = await fetchLatestOfp('LandingHangar711')

    expect(ofp.stepClimbs).toEqual([
      { atIdent: 'DUTUB', toAltitudeFt: expect.closeTo(8900 / 0.3048, 1), native: { unit: 'm', value: 8900 } }
    ])
  })

  it('finds stepclimb_string wherever it is nested in the response', async () => {
    const nested = fixture('kgs') as Record<string, unknown>
    nested.atc = { subsection: { stepclimb_string: 'DENAK/0350' } }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => nested }))
    )

    const ofp = await fetchLatestOfp('LandingHangar711')

    expect(ofp.stepClimbs).toEqual([
      { atIdent: 'DENAK', toAltitudeFt: 35000, native: { unit: 'ft', value: 35000 } }
    ])
  })

  it('converts weights when the SimBrief profile uses lbs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => fixture('lbs') }))
    )

    const ofp = await fetchLatestOfp('LandingHangar711')

    // 85029 lb -> kg
    expect(ofp.fuelPlannedKg).toBeCloseTo(85029 / 2.2046226218, 3)
    expect(ofp.zfwKg).toBeCloseTo(189112 / 2.2046226218, 3)
  })

  it('parses a missing cost index (empty SimBrief field, {}) as null rather than throwing', async () => {
    const noCostIndex = fixture('kgs') as { general: Record<string, unknown> }
    noCostIndex.general.costindex = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => noCostIndex }))
    )

    const ofp = await fetchLatestOfp('LandingHangar711')
    expect(ofp.costIndex).toBeNull()
  })

  it('reports a custom airframe with its full internal ID', async () => {
    const custom = fixture('kgs') as { aircraft: Record<string, unknown> }
    custom.aircraft.is_custom = '1'
    custom.aircraft.internal_id = '1191852_1763945117512'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => custom }))
    )

    const ofp = await fetchLatestOfp('LandingHangar711')
    expect(ofp.simbriefIsCustom).toBe(true)
    expect(ofp.simbriefInternalId).toBe('1191852_1763945117512')
  })

  it('throws when SimBrief reports an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ fetch: { status: 'Error' } }) }))
    )
    await expect(fetchLatestOfp('nobody')).rejects.toThrow('nobody')
  })

  it('throws on a non-2xx HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) }))
    )
    await expect(fetchLatestOfp('nobody')).rejects.toThrow('400')
  })
})

// Confirmed against a real China-crossing OFP (2026-09-02, see docs/decisions.md) — the
// exact stepclimb_string a user shared from an exported OFP JSON.
describe('parseStepClimbs', () => {
  it('returns no step climbs for an empty or missing string', () => {
    expect(parseStepClimbs(undefined)).toEqual([])
    expect(parseStepClimbs('')).toEqual([])
  })

  it('parses a standard flight level (code < 1000) as hundreds of feet', () => {
    expect(parseStepClimbs('DENAK/0350')).toEqual([
      { atIdent: 'DENAK', toAltitudeFt: 35000, native: { unit: 'ft', value: 35000 } }
    ])
  })

  it('parses a metric flight level (code >= 1000) as tens of metres, converted to feet', () => {
    const [climb] = parseStepClimbs('KAMUD/1130')
    expect(climb.atIdent).toBe('KAMUD')
    expect(climb.native).toEqual({ unit: 'm', value: 11300 })
    expect(climb.toAltitudeFt).toBeCloseTo(11300 / 0.3048, 1)
  })

  it('parses a real China-crossing stepclimb_string end to end', () => {
    const climbs = parseStepClimbs('EGLL/0330/DENAK/0350/SUDAR/0370/KAMUD/1130/OMBON/1190')
    expect(climbs.map((c) => c.atIdent)).toEqual(['EGLL', 'DENAK', 'SUDAR', 'KAMUD', 'OMBON'])
    expect(climbs.map((c) => c.native)).toEqual([
      { unit: 'ft', value: 33000 },
      { unit: 'ft', value: 35000 },
      { unit: 'ft', value: 37000 },
      { unit: 'm', value: 11300 },
      { unit: 'm', value: 11900 }
    ])
    expect(climbs[2].toAltitudeFt).toBe(37000)
    expect(climbs[3].toAltitudeFt).toBeCloseTo(11300 / 0.3048, 1)
    expect(climbs[4].toAltitudeFt).toBeCloseTo(11900 / 0.3048, 1)
  })

  it('ignores a trailing unpaired identifier', () => {
    expect(parseStepClimbs('DENAK/0350/TRAIL')).toEqual([
      { atIdent: 'DENAK', toAltitudeFt: 35000, native: { unit: 'ft', value: 35000 } }
    ])
  })

  // Real bug, 2026-09-06: Callum saw 8,900 m read as "89,000 ft" (27,127 m in metric
  // display). "0890" < 1000 so the old code>=1000 threshold called it FL890, not 8,900 m —
  // China's metric RVSM levels start well below 1000, so no threshold on the code alone
  // can tell these apart. Cross-referencing the navlog altitude resolves it correctly.
  it('reads a sub-1000 metric level correctly when the navlog altitude disambiguates it', () => {
    const navlogAltitudesFt = new Map([['DUTUB', 8900 / 0.3048]])
    const [climb] = parseStepClimbs('DUTUB/0890', navlogAltitudesFt)
    expect(climb.native).toEqual({ unit: 'm', value: 8900 })
    expect(climb.toAltitudeFt).toBeCloseTo(8900 / 0.3048, 1)
  })

  it('still reads a standard flight level correctly when the navlog altitude confirms it', () => {
    const navlogAltitudesFt = new Map([['DENAK', 35000]])
    expect(parseStepClimbs('DENAK/0350', navlogAltitudesFt)).toEqual([
      { atIdent: 'DENAK', toAltitudeFt: 35000, native: { unit: 'ft', value: 35000 } }
    ])
  })

  it('falls back to the plausibility threshold when the ident has no navlog match', () => {
    // No navlog entry for DUTUB: code 890 -> asFeet 89,000 ft, past MAX_PLAUSIBLE_FLIGHT_LEVEL_FT,
    // so it's correctly treated as metric even without a cross-reference.
    const [climb] = parseStepClimbs('DUTUB/0890', new Map([['OTHER', 12000]]))
    expect(climb.native).toEqual({ unit: 'm', value: 8900 })
  })
})
