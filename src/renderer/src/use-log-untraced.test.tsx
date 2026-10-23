import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { TaxiClearance } from '@shared/taxi/clearance'
import { useLogUntraced } from './use-taxi-route-highlight'

const diagMap = vi.hoisted(() => vi.fn())
vi.mock('./diag', () => ({ diagMap }))

const CLEARANCE: TaxiClearance = {
  taxiways: ['P', 'T'],
  holdingPoint: 'T',
  stand: null,
  holdShortRunway: null,
  taxiToRunway: '02C',
  from: { lat: 1.363, lon: 103.995 }
}

beforeEach(() => diagMap.mockClear())

describe('useLogUntraced', () => {
  it('says why a clearance has no line: its airport, whether the network is loaded, whether the aircraft has a position', () => {
    renderHook(() => useLogUntraced(CLEARANCE, null, 'WSSS', undefined))
    expect(diagMap).toHaveBeenCalledWith('taxi clearance not traced yet', {
      icao: 'WSSS',
      taxiways: ['P', 'T'],
      haveSegments: false,
      hasPosition: true
    })
  })

  it('says nothing when there is no clearance, or the line is traced', () => {
    renderHook(() => useLogUntraced(null, null, null, undefined))
    renderHook(() => useLogUntraced(CLEARANCE, [[103.99, 1.36]], 'WSSS', []))
    expect(diagMap).not.toHaveBeenCalled()
  })
})
