import { describe, expect, it } from 'vitest'
import {
  formatEnrouteOnly,
  parseRouteFromOfpJson,
  parseRouteProcedures,
  parseWaypointsFromOfpJson,
  segmentWaypoints
} from './route'

describe('parseRouteFromOfpJson', () => {
  it('extracts [lon, lat] pairs from navlog fixes', () => {
    const ofp = JSON.stringify({
      navlog: {
        fix: [
          { ident: 'BPK', pos_lat: '51.485872', pos_long: '-0.573167' },
          { ident: 'VHHH', pos_lat: '22.308889', pos_long: '113.914722' }
        ]
      }
    })
    expect(parseRouteFromOfpJson(ofp)).toEqual([
      [-0.573167, 51.485872],
      [113.914722, 22.308889]
    ])
  })

  it('returns an empty route for null input', () => {
    expect(parseRouteFromOfpJson(null)).toEqual([])
  })

  it('returns an empty route for invalid JSON', () => {
    expect(parseRouteFromOfpJson('not json')).toEqual([])
  })

  it('returns an empty route when navlog/fix is missing', () => {
    expect(parseRouteFromOfpJson(JSON.stringify({}))).toEqual([])
    expect(parseRouteFromOfpJson(JSON.stringify({ navlog: {} }))).toEqual([])
  })

  it('skips fixes with non-numeric coordinates', () => {
    const ofp = JSON.stringify({ navlog: { fix: [{ pos_lat: 'n/a', pos_long: '-0.5' }] } })
    expect(parseRouteFromOfpJson(ofp)).toEqual([])
  })
})

describe('parseWaypointsFromOfpJson', () => {
  it('extracts ident/lon/lat/altitude from navlog fixes', () => {
    const ofp = JSON.stringify({
      navlog: {
        fix: [
          { ident: 'BPK', pos_lat: '51.485872', pos_long: '-0.573167', altitude_feet: '5000' },
          { ident: 'VHHH', pos_lat: '22.308889', pos_long: '113.914722', altitude_feet: '0' }
        ]
      }
    })
    expect(parseWaypointsFromOfpJson(ofp)).toEqual([
      { ident: 'BPK', lon: -0.573167, lat: 51.485872, altitudeFt: 5000, segment: 'enroute' },
      { ident: 'VHHH', lon: 113.914722, lat: 22.308889, altitudeFt: 0, segment: 'enroute' }
    ])
  })

  it('returns an empty list for null input', () => {
    expect(parseWaypointsFromOfpJson(null)).toEqual([])
  })

  it('skips fixes with no ident or non-numeric coordinates', () => {
    const ofp = JSON.stringify({
      navlog: { fix: [{ pos_lat: '51.5', pos_long: '-0.5' }, { ident: 'X', pos_lat: 'n/a', pos_long: '-0.5' }] }
    })
    expect(parseWaypointsFromOfpJson(ofp)).toEqual([])
  })
})

describe('parseRouteProcedures', () => {
  const NONE = {
    departureRunway: null,
    sidIdent: null,
    sidTransition: null,
    starIdent: null,
    starTransition: null,
    arrivalRunway: null
  }

  it('reads sid_ident/star_ident/transitions, guarding the {}-when-absent trap', () => {
    expect(
      parseRouteProcedures(
        JSON.stringify({ general: { sid_ident: 'DET2G', sid_trans: {}, star_ident: {}, star_trans: {} } })
      )
    ).toEqual({ ...NONE, sidIdent: 'DET2G' })
  })

  it('reads sid_trans/star_trans when set', () => {
    expect(
      parseRouteProcedures(
        JSON.stringify({
          general: { sid_ident: 'DOTSS2', sid_trans: 'CLEEE', star_ident: 'PUCKY1', star_trans: 'WLKES' }
        })
      )
    ).toEqual({
      ...NONE,
      sidIdent: 'DOTSS2',
      sidTransition: 'CLEEE',
      starIdent: 'PUCKY1',
      starTransition: 'WLKES'
    })
  })

  it('reads departure/arrival runway from api_params.origrwy/destrwy', () => {
    expect(parseRouteProcedures(JSON.stringify({ api_params: { origrwy: '27L', destrwy: '20R' } }))).toEqual({
      ...NONE,
      departureRunway: '27L',
      arrivalRunway: '20R'
    })
  })

  it('returns nulls for missing general/api_params/null input', () => {
    expect(parseRouteProcedures(null)).toEqual(NONE)
    expect(parseRouteProcedures(JSON.stringify({}))).toEqual(NONE)
  })
})

describe('segmentWaypoints', () => {
  // Real navlog shape, EGLL departure (docs/simbrief-notes.md) — a SID with no
  // transition. D270A/DET both carry via_airway "DET2G"; DET itself is the navaid the
  // SID is named after and is deliberately included via via_airway despite what a naive
  // is_sid_star-only filter would do.
  it('includes a SID with no transition, ending exactly where via_airway stops matching', () => {
    const ofp = JSON.stringify({
      general: { sid_ident: 'DET2G' },
      navlog: {
        fix: [
          { ident: 'D270A', via_airway: 'DET2G', pos_lat: '1', pos_long: '1', altitude_feet: '2200' },
          { ident: 'DET', via_airway: 'DET2G', pos_lat: '2', pos_long: '2', altitude_feet: '6000' },
          { ident: 'DVR', via_airway: 'UL9', pos_lat: '3', pos_long: '3', altitude_feet: '35000' }
        ]
      }
    })
    const waypoints = segmentWaypoints(ofp)
    expect(waypoints.map((w) => w.segment)).toEqual(['sid', 'sid', 'enroute'])
  })

  // Real shape, VHHH arrival (docs/simbrief-notes.md) — a STAR with no transition: the
  // destination airport fix is itself part of the STAR segment.
  it('includes the destination airport fix inside a STAR with no transition', () => {
    const ofp = JSON.stringify({
      general: { star_ident: 'SIER7B' },
      navlog: {
        fix: [
          { ident: 'ENR1', via_airway: 'UL9', pos_lat: '1', pos_long: '1', altitude_feet: '35000' },
          { ident: 'STARFIX', via_airway: 'SIER7B', pos_lat: '2', pos_long: '2', altitude_feet: '8000' },
          { ident: 'VHHH', via_airway: 'SIER7B', pos_lat: '3', pos_long: '3', altitude_feet: '0' }
        ]
      }
    })
    const waypoints = segmentWaypoints(ofp)
    expect(waypoints.map((w) => w.segment)).toEqual(['enroute', 'star', 'star'])
  })

  // Real shape, KLAX -> KJFK with both a SID transition and a STAR transition
  // (docs/simbrief-notes.md). The STAR's handoff fix (WLKES) carries via_airway = the
  // inbound enroute airway (Q476), NOT the STAR name — via_airway alone can't find it,
  // which is exactly why STAR segmentation starts from star_trans's ident instead.
  it('handles both a SID transition and a STAR transition', () => {
    const ofp = JSON.stringify({
      general: { sid_ident: 'DOTSS2', sid_trans: 'CLEEE', star_ident: 'PUCKY1', star_trans: 'WLKES' },
      navlog: {
        fix: [
          { ident: 'DOTS', via_airway: 'DOTSS2', pos_lat: '1', pos_long: '1', altitude_feet: '2000' },
          { ident: 'CLEEE', via_airway: 'DOTSS2', pos_lat: '2', pos_long: '2', altitude_feet: '5000' },
          { ident: 'FIXA', via_airway: 'Q123', pos_lat: '3', pos_long: '3', altitude_feet: '35000' },
          { ident: 'WLKES', via_airway: 'Q476', pos_lat: '4', pos_long: '4', altitude_feet: '20000' },
          { ident: 'PUCKFIX', via_airway: 'PUCKY1', pos_lat: '5', pos_long: '5', altitude_feet: '8000' },
          { ident: 'KJFK', via_airway: 'PUCKY1', pos_lat: '6', pos_long: '6', altitude_feet: '0' }
        ]
      }
    })
    const waypoints = segmentWaypoints(ofp)
    expect(waypoints.map((w) => [w.ident, w.segment])).toEqual([
      ['DOTS', 'sid'],
      ['CLEEE', 'sid'],
      ['FIXA', 'enroute'],
      ['WLKES', 'star'],
      ['PUCKFIX', 'star'],
      ['KJFK', 'star']
    ])
  })

  it('is all enroute for a SID-only route with no STAR', () => {
    const ofp = JSON.stringify({
      general: { sid_ident: 'DET2G', star_ident: {}, star_trans: {} },
      navlog: {
        fix: [
          { ident: 'D270A', via_airway: 'DET2G', pos_lat: '1', pos_long: '1', altitude_feet: '2200' },
          { ident: 'ENR1', via_airway: 'UL9', pos_lat: '2', pos_long: '2', altitude_feet: '35000' },
          { ident: 'WSSS', via_airway: 'DCT', pos_lat: '3', pos_long: '3', altitude_feet: '0' }
        ]
      }
    })
    const waypoints = segmentWaypoints(ofp)
    expect(waypoints.map((w) => w.segment)).toEqual(['sid', 'enroute', 'enroute'])
  })

  it('is all enroute when the OFP names no SID or STAR at all', () => {
    const ofp = JSON.stringify({
      general: {},
      navlog: { fix: [{ ident: 'A', via_airway: 'DCT', pos_lat: '1', pos_long: '1', altitude_feet: '35000' }] }
    })
    expect(segmentWaypoints(ofp).map((w) => w.segment)).toEqual(['enroute'])
  })

  it('leaves TOC/TOD computed points alone, in the enroute segment', () => {
    const ofp = JSON.stringify({
      general: { sid_ident: 'DET2G' },
      navlog: {
        fix: [
          { ident: 'D270A', via_airway: 'DET2G', pos_lat: '1', pos_long: '1', altitude_feet: '2200' },
          { ident: 'TOC', type: 'ltlg', via_airway: 'DCT', pos_lat: '2', pos_long: '2', altitude_feet: '35000' }
        ]
      }
    })
    expect(segmentWaypoints(ofp).map((w) => w.segment)).toEqual(['sid', 'enroute'])
  })
})

describe('formatEnrouteOnly', () => {
  it('strips the SID name and its fixes, leaving the airway that starts the enroute portion', () => {
    const ofp = JSON.stringify({
      general: { sid_ident: 'DET2G', route: 'DET2G DET L6 DVR UL9 KONAN' },
      navlog: {
        fix: [
          { ident: 'D270A', via_airway: 'DET2G', pos_lat: '1', pos_long: '1', altitude_feet: '2200' },
          { ident: 'DET', via_airway: 'DET2G', pos_lat: '2', pos_long: '2', altitude_feet: '6000' },
          { ident: 'DVR', via_airway: 'L6', pos_lat: '3', pos_long: '3', altitude_feet: '35000' },
          { ident: 'KONAN', via_airway: 'UL9', pos_lat: '4', pos_long: '4', altitude_feet: '35000' }
        ]
      }
    })
    // D270A never appears in general.route itself (it's a navlog-only leg point), so this
    // also confirms filtering doesn't depend on every segmented fix being a literal token.
    expect(formatEnrouteOnly(ofp)).toBe('L6 DVR UL9 KONAN')
  })

  it('strips both a SID and a STAR (with transitions) from the route text', () => {
    // docs/simbrief-notes.md confirms sid_trans/star_trans and the navlog shape for this
    // route (KLAX->KJFK) but not the literal text of general.route for a transitioned
    // route — no real example was captured. This uses the same plain space-separated
    // token style confirmed for the no-transition case (general.route's documented
    // "DET2G DET L6 DVR..." shape), to test the filtering logic itself rather than assert
    // an unverified real-world format.
    const ofp = JSON.stringify({
      general: {
        sid_ident: 'DOTSS2',
        sid_trans: 'CLEEE',
        star_ident: 'PUCKY1',
        star_trans: 'WLKES',
        route: 'DOTSS2 CLEEE Q123 FIXA Q476 WLKES PUCKY1'
      },
      navlog: {
        fix: [
          { ident: 'DOTS', via_airway: 'DOTSS2', pos_lat: '1', pos_long: '1', altitude_feet: '2000' },
          { ident: 'CLEEE', via_airway: 'DOTSS2', pos_lat: '2', pos_long: '2', altitude_feet: '5000' },
          { ident: 'FIXA', via_airway: 'Q123', pos_lat: '3', pos_long: '3', altitude_feet: '35000' },
          { ident: 'WLKES', via_airway: 'Q476', pos_lat: '4', pos_long: '4', altitude_feet: '20000' },
          { ident: 'PUCKFIX', via_airway: 'PUCKY1', pos_lat: '5', pos_long: '5', altitude_feet: '8000' },
          { ident: 'KJFK', via_airway: 'PUCKY1', pos_lat: '6', pos_long: '6', altitude_feet: '0' }
        ]
      }
    })
    expect(formatEnrouteOnly(ofp)).toBe('Q123 FIXA Q476')
  })

  it('returns the route unchanged when the OFP names no SID or STAR', () => {
    const ofp = JSON.stringify({ general: { route: 'DVR UL9 KONAN' } })
    expect(formatEnrouteOnly(ofp)).toBe('DVR UL9 KONAN')
  })

  it('returns an empty string for null input or a missing route', () => {
    expect(formatEnrouteOnly(null)).toBe('')
    expect(formatEnrouteOnly(JSON.stringify({}))).toBe('')
  })
})
