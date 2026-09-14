import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMetars } from './metar-client'

// Real response shape captured live from
// https://aviationweather.gov/api/data/metar?ids=EGLL,KJFK&format=json
// (docs/decisions.md, 2026-09-02) — not synthesised.
const REAL_RESPONSE = [
  {
    icaoId: 'EGLL',
    receiptTime: '2026-09-01T23:24:21.089Z',
    obsTime: 1788304800,
    reportTime: '2026-09-01T23:20:00.000Z',
    temp: 18,
    dewp: 12,
    wdir: 250,
    wspd: 8,
    visib: '6+',
    altim: 1020,
    rawOb: 'METAR EGLL 012320Z AUTO 25008KT 9999 NCD 18/12 Q1020',
    lat: 51.477,
    lon: -0.461,
    name: 'London/Heathrow Intl, EN, GB',
    fltCat: 'VFR'
  },
  {
    icaoId: 'KJFK',
    reportTime: '2026-09-01T23:00:00.000Z',
    rawOb:
      'KJFK 012300Z 14006KT 5SM HZ FEW250 24/22 A2996 RMK AO2 SLP145 T02440222',
    fltCat: 'IFR'
  }
]

describe('fetchMetars', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps real aviationweather.gov responses to MetarReport', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => REAL_RESPONSE }))
    )

    const result = await fetchMetars(['EGLL', 'KJFK'])

    expect(result).toEqual([
      {
        icao: 'EGLL',
        rawText: 'METAR EGLL 012320Z AUTO 25008KT 9999 NCD 18/12 Q1020',
        observedUtc: '2026-09-01T23:20:00.000Z',
        flightCategory: 'VFR'
      },
      {
        icao: 'KJFK',
        rawText: 'KJFK 012300Z 14006KT 5SM HZ FEW250 24/22 A2996 RMK AO2 SLP145 T02440222',
        observedUtc: '2026-09-01T23:00:00.000Z',
        flightCategory: 'IFR'
      }
    ])
  })

  it('returns an empty array without calling fetch when given no codes', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchMetars([])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('dedupes and uppercases codes before requesting', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchMetars(['egll', 'EGLL', ' kjfk '])

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('ids=EGLL%2CKJFK')
    )
  })

  it('returns an empty array (not an error) for HTTP 204 — every code unknown/non-reporting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 204, json: async () => undefined }))
    )

    expect(await fetchMetars(['ZZZZ'])).toEqual([])
  })

  it('throws for a non-204 failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => undefined }))
    )

    await expect(fetchMetars(['EGLL'])).rejects.toThrow(/HTTP 500/)
  })

  it('returns an empty array when the response body is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }))
    )

    expect(await fetchMetars(['EGLL'])).toEqual([])
  })

  it('filters out entries missing icaoId/rawOb, and defaults an unknown reportTime/fltCat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { icaoId: 'EGLL' }, // no rawOb — dropped
          { rawOb: 'METAR KJFK ...' }, // no icaoId — dropped
          { icaoId: 'EGNM', rawOb: 'METAR EGNM ...', fltCat: 'SOMETHING_UNKNOWN' } // no reportTime
        ]
      }))
    )

    expect(await fetchMetars(['EGLL', 'KJFK', 'EGNM'])).toEqual([
      { icao: 'EGNM', rawText: 'METAR EGNM ...', observedUtc: '', flightCategory: null }
    ])
  })
})
