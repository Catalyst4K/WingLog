import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { NavdataLeg, ProcedureSelection, WingLogApi } from '@shared/ipc'
import { arrivalAirport, emptyProcedureSelection, useLiveWaypoints, type ProcedureAirports } from './procedureSelection'

function leg(fixIdent: string): NavdataLeg {
  return {
    type: 4,
    fixIdent,
    fixType: 'W',
    fixLatitude: 10,
    fixLongitude: 20,
    turnDirection: 0,
    courseDeg: 0,
    altitude1: 0,
    altitude2: 0,
    speedLimit: 0,
    routeDistanceM: 0
  }
}

const ofpJson = JSON.stringify({
  navlog: {
    fix: [
      { ident: 'SIDFIX', type: 'wpt', pos_lat: '1', pos_long: '1', altitude_feet: '3000', stage: 'CLB', is_sid_star: '1' },
      { ident: 'CRUISE', type: 'wpt', pos_lat: '2', pos_long: '2', altitude_feet: '35000', stage: 'CRZ', is_sid_star: '0' }
    ]
  }
})

function airports(overrides: Partial<ProcedureAirports> = {}): ProcedureAirports {
  return { depIcao: 'EGLL', arrIcao: 'KJFK', altnIcao: 'KEWR', ofpJson: null, ...overrides }
}

describe('arrivalAirport', () => {
  it('is the filed destination unless the selection names the alternate', () => {
    expect(arrivalAirport(airports(), emptyProcedureSelection())).toBe('KJFK')
    expect(arrivalAirport(airports(), { ...emptyProcedureSelection(), arrivalIcao: 'KEWR' })).toBe('KEWR')
  })
})

describe('useLiveWaypoints with the alternate as the arrival airport (v1.1.1)', () => {
  it("fetches the STAR and approach legs for the alternate, not the destination, and builds the route from them", async () => {
    const navdataGetProcedureWaypoints = vi.fn((icao: string, kind: string) =>
      Promise.resolve(kind === 'star' ? [leg(`${icao}-STAR`)] : [leg(`${icao}-APP`)])
    )
    window.winglog = { navdataGetProcedureWaypoints } as unknown as WingLogApi
    const selection: ProcedureSelection = {
      ...emptyProcedureSelection(),
      starIdent: 'ALT1A',
      approachIdent: 'ILS 04R',
      arrivalIcao: 'KEWR'
    }

    const { result } = renderHook(() => useLiveWaypoints(airports({ ofpJson }), selection))

    await waitFor(() => expect(result.current.map((w) => w.ident)).toEqual(expect.arrayContaining(['KEWR-STAR', 'KEWR-APP'])))
    expect(navdataGetProcedureWaypoints).toHaveBeenCalledWith('KEWR', 'star', 'ALT1A', '04R', null)
    expect(navdataGetProcedureWaypoints).toHaveBeenCalledWith('KEWR', 'approach', 'ILS 04R', null, null)
    expect(navdataGetProcedureWaypoints).not.toHaveBeenCalledWith('KJFK', expect.anything(), expect.anything(), expect.anything(), expect.anything())
    // The filed cruise stays in the route.
    expect(result.current.map((w) => w.ident)).toContain('CRUISE')
  })

  it('uses the destination when no alternate is selected', async () => {
    const navdataGetProcedureWaypoints = vi.fn().mockResolvedValue([leg('X')])
    window.winglog = { navdataGetProcedureWaypoints } as unknown as WingLogApi
    renderHook(() => useLiveWaypoints(airports(), { ...emptyProcedureSelection(), approachIdent: 'ILS 22R' }))
    await waitFor(() => expect(navdataGetProcedureWaypoints).toHaveBeenCalledWith('KJFK', 'approach', 'ILS 22R', null, null))
  })
})
