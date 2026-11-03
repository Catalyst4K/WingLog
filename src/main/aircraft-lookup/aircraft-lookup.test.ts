import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupAircraft } from './aircraft-lookup'

const { fetchAircraftByRegistration, fetchPlanespottersPhoto, warn } = vi.hoisted(() => ({
  fetchAircraftByRegistration: vi.fn(),
  fetchPlanespottersPhoto: vi.fn(),
  warn: vi.fn()
}))
vi.mock('./adsbdb-client', () => ({ fetchAircraftByRegistration }))
vi.mock('./planespotters-client', () => ({ fetchPlanespottersPhoto }))
vi.mock('../logging/logger', () => ({ logger: { warn } }))

const ADSBDB = {
  icaoType: 'A320',
  operator: 'easyJet',
  operatorIcao: 'EZY',
  photoThumbnailUrl: 'https://airport-data.com/t.jpg',
  photoUrl: 'https://image.airport-data.com/f.jpg'
}
const SPOTTERS = {
  photoUrl: 'https://t.plnspttrs.net/a_280.jpg',
  photographer: 'John Robert Murdoch',
  pageUrl: 'https://www.planespotters.net/photo/1'
}

describe('lookupAircraft', () => {
  beforeEach(() => {
    fetchAircraftByRegistration.mockReset()
    fetchPlanespottersPhoto.mockReset()
    warn.mockReset()
  })

  it('adds Planespotters’ photo to what adsbdb knows, sending its User-Agent', async () => {
    fetchAircraftByRegistration.mockResolvedValue(ADSBDB)
    fetchPlanespottersPhoto.mockResolvedValue(SPOTTERS)
    expect(await lookupAircraft('G-EZTK', 'WingLog/1.7.0')).toEqual({ ...ADSBDB, planespotters: SPOTTERS })
    expect(fetchPlanespottersPhoto).toHaveBeenCalledWith('G-EZTK', 'WingLog/1.7.0')
  })

  it('does not ask Planespotters about a registration adsbdb does not know', async () => {
    fetchAircraftByRegistration.mockResolvedValue(null)
    expect(await lookupAircraft('N-FAKE1', 'WingLog')).toBeNull()
    expect(fetchPlanespottersPhoto).not.toHaveBeenCalled()
  })

  it('still answers, without the photo, and logs why, when Planespotters fails', async () => {
    fetchAircraftByRegistration.mockResolvedValue(ADSBDB)
    fetchPlanespottersPhoto.mockRejectedValue(new Error('Planespotters lookup failed (HTTP 403)'))
    expect(await lookupAircraft('G-EZTK', 'WingLog')).toEqual({ ...ADSBDB, planespotters: null })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 403'))
  })

  it('fails when adsbdb fails: the type and operator are what the lookup is for', async () => {
    fetchAircraftByRegistration.mockRejectedValue(new Error('adsbdb lookup failed (HTTP 503)'))
    await expect(lookupAircraft('G-EZTK', 'WingLog')).rejects.toThrow('adsbdb lookup failed')
  })
})
