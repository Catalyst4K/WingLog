import { describe, expect, it } from 'vitest'
import { flightLabel } from './flight-label'

describe('flightLabel', () => {
  it('prefers the flight number / callsign', () => {
    expect(flightLabel({ flightNumber: 'BAW123', depIcao: 'EGLL', arrIcao: 'VHHH' })).toBe('BAW123')
    expect(flightLabel({ flightNumber: '  ', depIcao: 'EGLL', arrIcao: 'VHHH' })).toBe('EGLL → VHHH')
  })

  it('falls back to the route, then to whichever end is known', () => {
    expect(flightLabel({ flightNumber: null, depIcao: 'VHHH', arrIcao: 'VHHX' })).toBe('VHHH → VHHX')
    expect(flightLabel({ flightNumber: null, depIcao: 'VHHH', arrIcao: 'ZZZZ' })).toBe('flight from VHHH')
    expect(flightLabel({ flightNumber: null, depIcao: 'ZZZZ', arrIcao: 'VHHH' })).toBe('flight to VHHH')
  })

  it('never shows a database id, even with nothing known', () => {
    expect(flightLabel({ flightNumber: null, depIcao: 'ZZZZ', arrIcao: 'ZZZZ' })).toBe('this flight')
    expect(flightLabel(undefined)).toBe('this flight')
    expect(flightLabel(null)).toBe('this flight')
  })
})
