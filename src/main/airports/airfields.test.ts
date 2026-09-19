import { describe, expect, it } from 'vitest'
import { loadAirfields } from './airfields'

const HEADER = 'icao,name,municipality,iso_country,type,latitude_deg,longitude_deg'

describe('loadAirfields', () => {
  it('keeps every landable type with its position, including a quoted name with a comma', () => {
    const csv = [
      HEADER,
      'EGLL,London Heathrow Airport,London,GB,large_airport,51.4706,-0.461941',
      'EGKB,"Biggin Hill, London Airport",Westerham,GB,small_airport,51.3308,0.0325',
      'K00A,Total RF Heliport,Bensalem,US,heliport,40.070985,-74.933689',
      'ENSB,Svalbard Water,Longyearbyen,NO,seaplane_base,78.2,15.6',
      'EGLF,Farnborough,Farnborough,GB,medium_airport,51.2758,-0.7763'
    ].join('\n')

    const result = loadAirfields(csv)

    expect(result.map((a) => a.icao)).toEqual(['EGLL', 'EGKB', 'K00A', 'ENSB', 'EGLF'])
    expect(result[1]).toEqual({
      icao: 'EGKB',
      name: 'Biggin Hill, London Airport',
      type: 'small_airport',
      latitude: 51.3308,
      longitude: 0.0325
    })
  })

  it('drops balloonports, unknown types, and rows with no usable position or ICAO', () => {
    const csv = [
      HEADER,
      'BALL,Balloon Field,X,GB,balloonport,51,0',
      'ZZZZ,Mystery,X,GB,closed,51,0',
      'NOLL,No Lat,X,GB,small_airport,,0',
      'NAN1,Bad Lat,X,GB,small_airport,abc,0',
      'OOR1,Out Of Range,X,GB,small_airport,95,0',
      'OOR2,Out Of Range,X,GB,small_airport,0,200',
      ',No Icao,X,GB,small_airport,51,0',
      'GOOD,Good,X,GB,small_airport,51,0'
    ].join('\n')

    expect(loadAirfields(csv).map((a) => a.icao)).toEqual(['GOOD'])
  })

  it('accepts a real airfield at exactly 0,0 and at the extremes', () => {
    const csv = [
      HEADER,
      'ZERO,Null Island,X,XX,small_airport,0,0',
      'EXTR,Edge,X,XX,small_airport,-90,-180'
    ].join('\n')
    expect(loadAirfields(csv).map((a) => a.icao)).toEqual(['ZERO', 'EXTR'])
  })

  it('reads the real vendored file to a plausible size', async () => {
    const { readFileSync } = await import('node:fs')
    const real = loadAirfields(readFileSync('resources/airports.csv', 'utf-8'))
    expect(real.length).toBeGreaterThan(40_000)
    expect(real.find((a) => a.icao === 'EGLL')?.type).toBe('large_airport')
    expect(real.every((a) => a.type !== ('balloonport' as never))).toBe(true)
  })
})
