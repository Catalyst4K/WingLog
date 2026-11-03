import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { PlanespottersPhoto } from '@shared/ipc'
import { createAircraft, listAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { getSetting } from '../db/settings-repo'
import type { AdsbdbResult } from './adsbdb-client'
import { PHOTO_BACKFILL_DONE_KEY, PHOTO_BACKFILL_PAUSE_MS, backfillAircraftPhotos } from './photo-backfill'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn() } }))

const THUMB = 'https://airport-data.com/images/aircraft/thumbnails/001/640/001640371.jpg'
const FULL = 'https://image.airport-data.com/aircraft/001640371.jpg'
const SPOTTERS: PlanespottersPhoto = {
  photoUrl: 'https://t.plnspttrs.net/03324/1993434_f8404af4fc_280.jpg',
  photographer: 'Chris Pitchacaren',
  pageUrl: 'https://www.planespotters.net/photo/1993434/b-lrj'
}

function adsbdb(overrides: Partial<AdsbdbResult> = {}): AdsbdbResult {
  return {
    icaoType: 'A359',
    operator: null,
    operatorIcao: null,
    photoThumbnailUrl: THUMB,
    photoUrl: FULL,
    ...overrides
  }
}

describe('backfillAircraftPhotos', () => {
  let db: WingLogDb
  const pause = vi.fn().mockResolvedValue(undefined)
  const both = { fetchAircraft: async () => adsbdb(), fetchPlanespotters: async () => SPOTTERS, pause }

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    pause.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives an aircraft that has only the old thumbnail its Planespotters photo and its full-size photo, keeping the rest', async () => {
    createAircraft(db, {
      registration: 'B-LRJ',
      icaoType: 'A359',
      operator: 'Cathay',
      photoThumbnailUrl: 'https://airport-data.com/old.jpg'
    })
    const onChanged = vi.fn()
    expect(await backfillAircraftPhotos(db, { ...both, onChanged })).toBe(1)
    expect(listAircraft(db)[0]).toMatchObject({
      registration: 'B-LRJ',
      operator: 'Cathay',
      photoThumbnailUrl: 'https://airport-data.com/old.jpg',
      photoUrl: FULL,
      planespottersPhotoUrl: SPOTTERS.photoUrl,
      planespottersPhotographer: 'Chris Pitchacaren',
      planespottersPageUrl: SPOTTERS.pageUrl,
      customPhoto: null
    })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('fills the thumbnail too for an aircraft that had no photo at all', async () => {
    createAircraft(db, { registration: 'G-EZTK', icaoType: 'A320' })
    await backfillAircraftPhotos(db, both)
    expect(listAircraft(db)[0]).toMatchObject({ photoThumbnailUrl: THUMB, photoUrl: FULL })
  })

  it('asks only the service an aircraft is missing a photo from', async () => {
    createAircraft(db, { registration: 'G-HAVE', icaoType: 'A320', photoUrl: FULL })
    const fetchAircraft = vi.fn(async () => adsbdb())
    const fetchPlanespotters = vi.fn(async () => SPOTTERS)
    await backfillAircraftPhotos(db, { fetchAircraft, fetchPlanespotters, pause })
    expect(fetchAircraft).not.toHaveBeenCalled()
    expect(fetchPlanespotters).toHaveBeenCalledWith('G-HAVE')
    expect(listAircraft(db)[0].planespottersPhotoUrl).toBe(SPOTTERS.photoUrl)
  })

  it('does not ask about an aircraft that already has both, and keeps the pilot’s own picture', async () => {
    createAircraft(db, {
      registration: 'G-DONE',
      icaoType: 'A320',
      photoUrl: FULL,
      planespottersPhotoUrl: SPOTTERS.photoUrl,
      planespottersPhotographer: 'Someone',
      planespottersPageUrl: SPOTTERS.pageUrl
    })
    createAircraft(db, {
      registration: 'G-OWNN',
      icaoType: 'A320',
      customPhoto: 'data:image/jpeg;base64,/9j/4AAQ'
    })
    const fetchAircraft = vi.fn(async () => adsbdb())
    await backfillAircraftPhotos(db, { fetchAircraft, fetchPlanespotters: async () => SPOTTERS, pause })
    expect(fetchAircraft).toHaveBeenCalledTimes(1)
    expect(fetchAircraft).toHaveBeenCalledWith('G-OWNN')
    expect(listAircraft(db).find((a) => a.registration === 'G-OWNN')?.customPhoto).toBe(
      'data:image/jpeg;base64,/9j/4AAQ'
    )
    expect(listAircraft(db).find((a) => a.registration === 'G-DONE')?.planespottersPhotographer).toBe(
      'Someone'
    )
  })

  it('leaves an aircraft neither service has a photo for, and is still done', async () => {
    createAircraft(db, { registration: 'N-FAKE', icaoType: 'C172' })
    const onChanged = vi.fn()
    const none = { fetchAircraft: async () => null, fetchPlanespotters: async () => null, pause, onChanged }
    expect(await backfillAircraftPhotos(db, none)).toBe(0)
    expect(listAircraft(db)[0]).toMatchObject({ photoUrl: null, planespottersPhotoUrl: null })
    expect(onChanged).not.toHaveBeenCalled()
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeDefined()
  })

  it('does not keep a full-size link that is not https', async () => {
    createAircraft(db, { registration: 'G-EVIL', icaoType: 'A320' })
    await backfillAircraftPhotos(db, {
      ...both,
      fetchAircraft: async () =>
        adsbdb({ photoUrl: 'javascript:alert(1)', photoThumbnailUrl: 'http://x.example/t.jpg' })
    })
    expect(listAircraft(db)[0]).toMatchObject({ photoUrl: null, photoThumbnailUrl: null })
  })

  it('waits between aircraft, not before the first', async () => {
    for (const registration of ['G-AAAA', 'G-BBBB', 'G-CCCC'])
      createAircraft(db, { registration, icaoType: 'A320' })
    await backfillAircraftPhotos(db, both)
    expect(pause).toHaveBeenCalledTimes(2)
    expect(pause).toHaveBeenCalledWith(PHOTO_BACKFILL_PAUSE_MS)
    expect(PHOTO_BACKFILL_PAUSE_MS).toBeGreaterThanOrEqual(2000)
  })

  it('really waits when no clock is given, and names WingLog to Planespotters when no lookup is given', async () => {
    vi.useFakeTimers()
    createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320', photoUrl: FULL })
    createAircraft(db, { registration: 'G-BBBB', icaoType: 'A320', photoUrl: FULL })
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ photos: [] }) }))
    vi.stubGlobal('fetch', fetchMock)
    const done = backfillAircraftPhotos(db, { userAgent: 'WingLog/1.7.0' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PHOTO_BACKFILL_PAUSE_MS)
    expect(await done).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).toMatchObject({ 'User-Agent': 'WingLog/1.7.0' })
    vi.unstubAllGlobals()
  })

  it('runs once: a finished pass is never repeated, even for an aircraft added since', async () => {
    createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320' })
    await backfillAircraftPhotos(db, both)
    createAircraft(db, { registration: 'G-LATE', icaoType: 'A320' })
    const fetchAircraft = vi.fn(async () => adsbdb())
    expect(await backfillAircraftPhotos(db, { ...both, fetchAircraft })).toBe(0)
    expect(fetchAircraft).not.toHaveBeenCalled()
  })

  it('finishes with nothing to do when there are no aircraft, and records it', async () => {
    expect(await backfillAircraftPhotos(db, both)).toBe(0)
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeDefined()
  })

  it('keeps what one service gave when the other fails, does not record the pass, and next time asks only for what is missing', async () => {
    createAircraft(db, { registration: 'G-LIMT', icaoType: 'A320' })
    const limited = vi.fn(async () => {
      throw new Error('Planespotters lookup failed (HTTP 403) for registration "G-LIMT"')
    })
    expect(await backfillAircraftPhotos(db, { ...both, fetchPlanespotters: limited })).toBe(1)
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeUndefined()
    expect(listAircraft(db)[0]).toMatchObject({ photoUrl: FULL, planespottersPhotoUrl: null })

    const fetchAircraft = vi.fn(async () => adsbdb())
    expect(await backfillAircraftPhotos(db, { ...both, fetchAircraft })).toBe(1)
    expect(fetchAircraft).not.toHaveBeenCalled()
    expect(listAircraft(db)[0].planespottersPhotoUrl).toBe(SPOTTERS.photoUrl)
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeDefined()
  })

  it('keeps going past an aircraft that fails, and retries only it next time', async () => {
    createAircraft(db, { registration: 'G-DOWN', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-FINE', icaoType: 'A320' })
    const flaky = vi.fn(async (registration: string) => {
      if (registration === 'G-DOWN') throw new Error('adsbdb lookup failed (HTTP 503)')
      return adsbdb()
    })
    expect(await backfillAircraftPhotos(db, { ...both, fetchAircraft: flaky })).toBe(1)
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeUndefined()

    const retry = vi.fn(async () => adsbdb())
    await backfillAircraftPhotos(db, { ...both, fetchAircraft: retry })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('G-DOWN')
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeDefined()
  })
})
