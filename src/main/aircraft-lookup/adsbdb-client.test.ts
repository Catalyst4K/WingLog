import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAircraftByRegistration } from './adsbdb-client'

// Real response shape captured live from https://api.adsbdb.com/v0/aircraft/G-XWBS
// (docs/decisions.md, 2026-09-01) — not synthesised.
const REAL_RESPONSE = {
  response: {
    aircraft: {
      type: 'A350-1041',
      icao_type: 'A35K',
      manufacturer: 'Airbus Sas',
      mode_s: '407FCD',
      registration: 'G-XWBS',
      registered_owner_country_iso_name: 'GB',
      registered_owner_country_name: 'United Kingdom',
      registered_owner_operator_flag_code: 'BAW',
      registered_owner: 'British Airways',
      url_photo: null,
      url_photo_thumbnail: null
    }
  }
}

describe('fetchAircraftByRegistration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps a found aircraft to icaoType/operator', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => REAL_RESPONSE }))
    )

    const result = await fetchAircraftByRegistration('G-XWBS')

    expect(result).toEqual({
      icaoType: 'A35K',
      operator: 'British Airways',
      operatorIcao: 'BAW',
      photoThumbnailUrl: null
    })
  })

  it('returns a null operatorIcao when adsbdb has no operator flag code for this aircraft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          response: { aircraft: { icao_type: 'A35K', registered_owner: 'British Airways' } }
        })
      }))
    )

    const result = await fetchAircraftByRegistration('G-XWBS')

    expect(result).toEqual({
      icaoType: 'A35K',
      operator: 'British Airways',
      operatorIcao: null,
      photoThumbnailUrl: null
    })
  })

  // Real response shape captured live from https://api.adsbdb.com/v0/aircraft/G-EZTK
  // (docs/decisions.md, 2026-09-07) — deliberately maps url_photo_thumbnail, not
  // url_photo (full-size): spot-checked live and the full-size URL 404s consistently.
  it('maps url_photo_thumbnail to photoThumbnailUrl, ignoring the unreliable full-size url_photo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            aircraft: {
              icao_type: 'A320',
              registered_owner: 'easyJet Airline',
              url_photo: 'https://image.airport-data.com/aircraft/001685661.jpg',
              url_photo_thumbnail: 'https://airport-data.com/images/aircraft/thumbnails/001/685/001685661.jpg'
            }
          }
        })
      }))
    )

    const result = await fetchAircraftByRegistration('G-EZTK')

    expect(result?.photoThumbnailUrl).toBe(
      'https://airport-data.com/images/aircraft/thumbnails/001/685/001685661.jpg'
    )
  })

  it('returns null (not an error) for a 404 — a made-up or unrecognised registration', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => undefined }))
    )

    const result = await fetchAircraftByRegistration('ZZ-FAKE1')

    expect(result).toBeNull()
  })

  it('throws for a non-404 failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => undefined }))
    )

    await expect(fetchAircraftByRegistration('G-XWBS')).rejects.toThrow(/HTTP 500/)
  })

  it('returns a null operator when adsbdb has no registered owner for this aircraft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ response: { aircraft: { icao_type: 'A35K' } } })
      }))
    )

    const result = await fetchAircraftByRegistration('G-XWBS')

    expect(result?.operator).toBeNull()
  })

  it('throws when the response is missing the expected aircraft data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ response: {} }) }))
    )

    await expect(fetchAircraftByRegistration('G-XWBS')).rejects.toThrow(/missing/)
  })
})
