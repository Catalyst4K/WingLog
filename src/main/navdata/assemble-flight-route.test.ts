import { describe, expect, it, vi } from 'vitest'
import { emptyProcedureSelection } from '@shared/procedure-selection'
import { assembleFlightRoute } from './assemble-flight-route'

const OFP = JSON.stringify({
  general: {},
  navlog: {
    fix: [
      { ident: 'EGLL', pos_lat: '51.47', pos_long: '-0.46', altitude_feet: '83', via_airway: 'DCT' },
      { ident: 'LAM', pos_lat: '51.65', pos_long: '0.15', altitude_feet: '9000', via_airway: 'DCT' }
    ]
  }
})
const FLIGHT = { depIcao: 'EGLL', arrIcao: 'EGKK', ofpJson: OFP }
const RUNWAYS = [
  {
    ident: '27L',
    headingTrueDeg: 270,
    lengthM: 3900,
    widthM: 50,
    surface: 1,
    thresholdLat: 51.4777,
    thresholdLon: -0.4339
  },
  {
    ident: '09R',
    headingTrueDeg: 90,
    lengthM: 3900,
    widthM: 50,
    surface: 1,
    thresholdLat: 51.4775,
    thresholdLon: -0.4822
  }
]
const navdata = (listRunways?: () => typeof RUNWAYS) => ({
  getProcedureWaypoints: vi.fn().mockReturnValue([]),
  ...(listRunways ? { listRunways } : {})
})

describe('assembleFlightRoute and the departure runway', () => {
  it('starts the route along the chosen departure runway, from the cached runways', () => {
    const { waypoints } = assembleFlightRoute(
      FLIGHT,
      { ...emptyProcedureSelection(), departureRunway: '27L' },
      navdata(() => RUNWAYS)
    )
    // Departing west from Heathrow for a fix to the east: it lies behind the runway end, so the centreline carries on for a climb-out.
    expect(waypoints.map((w) => w.ident)).toEqual(['RW27L', '', '', 'LAM'])
    expect(waypoints[0]).toMatchObject({ lat: 51.4777, lon: -0.4339, runwayPoint: true })
  })

  it('is the OFP’s own route when no runway is chosen, or the chosen one is not cached, or the cache cannot be asked', () => {
    const idents = (
      selection: ReturnType<typeof emptyProcedureSelection>,
      nav: ReturnType<typeof navdata>
    ): string[] => assembleFlightRoute(FLIGHT, selection, nav).waypoints.map((w) => w.ident)
    expect(
      idents(
        emptyProcedureSelection(),
        navdata(() => RUNWAYS)
      )
    ).toEqual(['EGLL', 'LAM'])
    expect(
      idents(
        { ...emptyProcedureSelection(), departureRunway: '99' },
        navdata(() => RUNWAYS)
      )
    ).toEqual(['EGLL', 'LAM'])
    expect(idents({ ...emptyProcedureSelection(), departureRunway: '27L' }, navdata())).toEqual([
      'EGLL',
      'LAM'
    ])
  })
})
