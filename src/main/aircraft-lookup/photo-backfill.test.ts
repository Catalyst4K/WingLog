import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { AircraftLookupResult } from '@shared/ipc'
import { createAircraft, listAircraft } from '../db/aircraft-repo'
import { createDb, type WingLogDb } from '../db/client'
import { getSetting } from '../db/settings-repo'
import { PHOTO_BACKFILL_DONE_KEY, PHOTO_BACKFILL_PAUSE_MS, backfillAircraftPhotos } from './photo-backfill'

vi.mock('../logging/logger', () => ({ logger: { warn: vi.fn() } }))

const THUMB = 'https://airport-data.com/images/aircraft/thumbnails/001/640/001640371.jpg'
const FULL = 'https://image.airport-data.com/aircraft/001640371.jpg'

function found(overrides: Partial<AircraftLookupResult> = {}): AircraftLookupResult {
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

  beforeEach(() => {
    db = createDb(':memory:').db
    migrate(db, { migrationsFolder: 'drizzle' })
    pause.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives an aircraft that has only the old thumbnail its full-size photo, leaving the thumbnail and everything else as it was', async () => {
    createAircraft(db, {
      registration: 'B-LRJ',
      icaoType: 'A359',
      operator: 'Cathay',
      photoThumbnailUrl: 'https://airport-data.com/old.jpg'
    })
    const onChanged = vi.fn()
    const gained = await backfillAircraftPhotos(db, { fetchAircraft: async () => found(), pause, onChanged })
    expect(gained).toBe(1)
    expect(listAircraft(db)[0]).toMatchObject({
      registration: 'B-LRJ',
      operator: 'Cathay',
      photoThumbnailUrl: 'https://airport-data.com/old.jpg',
      photoUrl: FULL,
      customPhoto: null
    })
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('fills the thumbnail too for an aircraft that had no photo at all', async () => {
    createAircraft(db, { registration: 'G-EZTK', icaoType: 'A320' })
    await backfillAircraftPhotos(db, { fetchAircraft: async () => found(), pause })
    expect(listAircraft(db)[0]).toMatchObject({ photoThumbnailUrl: THUMB, photoUrl: FULL })
  })

  it('does not ask about an aircraft that already has its full-size photo, and keeps the pilot’s own picture', async () => {
    createAircraft(db, { registration: 'G-HAVE', icaoType: 'A320', photoUrl: FULL })
    createAircraft(db, {
      registration: 'G-OWNN',
      icaoType: 'A320',
      customPhoto: 'data:image/jpeg;base64,/9j/4AAQ'
    })
    const fetchAircraft = vi.fn(async () =>
      found({ photoUrl: 'https://image.airport-data.com/aircraft/other.jpg' })
    )
    await backfillAircraftPhotos(db, { fetchAircraft, pause })
    expect(fetchAircraft).toHaveBeenCalledTimes(1)
    expect(fetchAircraft).toHaveBeenCalledWith('G-OWNN')
    const own = listAircraft(db).find((a) => a.registration === 'G-OWNN')
    expect(own?.customPhoto).toBe('data:image/jpeg;base64,/9j/4AAQ')
  })

  it('leaves an aircraft adsbdb does not know, or has no full-size photo for, and is still done', async () => {
    createAircraft(db, { registration: 'N-FAKE', icaoType: 'C172' })
    createAircraft(db, { registration: 'G-NOPH', icaoType: 'A320' })
    const results = [null, found({ photoUrl: null, photoThumbnailUrl: null })]
    const onChanged = vi.fn()
    expect(
      await backfillAircraftPhotos(db, {
        fetchAircraft: async () => results.shift() ?? null,
        pause,
        onChanged
      })
    ).toBe(0)
    expect(listAircraft(db).map((a) => a.photoUrl)).toEqual([null, null])
    expect(onChanged).not.toHaveBeenCalled()
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeDefined()
  })

  it.each([
    ['a link that is not https', 'http://image.airport-data.com/aircraft/1.jpg'],
    ['a script link', 'javascript:alert(1)']
  ])('does not keep %s from the service', async (_label, photoUrl) => {
    createAircraft(db, { registration: 'G-EVIL', icaoType: 'A320' })
    await backfillAircraftPhotos(db, { fetchAircraft: async () => found({ photoUrl }), pause })
    expect(listAircraft(db)[0].photoUrl).toBeNull()
  })

  it('waits between aircraft, but not before the first', async () => {
    for (const registration of ['G-AAAA', 'G-BBBB', 'G-CCCC'])
      createAircraft(db, { registration, icaoType: 'A320' })
    await backfillAircraftPhotos(db, { fetchAircraft: async () => found(), pause })
    expect(pause).toHaveBeenCalledTimes(2)
    expect(pause).toHaveBeenCalledWith(PHOTO_BACKFILL_PAUSE_MS)
  })

  it('really waits when no clock is given', async () => {
    vi.useFakeTimers()
    createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-BBBB', icaoType: 'A320' })
    const fetchAircraft = vi.fn(async () => found())
    const done = backfillAircraftPhotos(db, { fetchAircraft })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchAircraft).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(PHOTO_BACKFILL_PAUSE_MS)
    expect(await done).toBe(2)
  })

  it('runs once: a finished pass is never repeated, even for an aircraft added since', async () => {
    createAircraft(db, { registration: 'G-AAAA', icaoType: 'A320' })
    await backfillAircraftPhotos(db, { fetchAircraft: async () => found(), pause })
    createAircraft(db, { registration: 'G-LATE', icaoType: 'A320' })
    const fetchAircraft = vi.fn(async () => found())
    expect(await backfillAircraftPhotos(db, { fetchAircraft, pause })).toBe(0)
    expect(fetchAircraft).not.toHaveBeenCalled()
  })

  it('finishes with nothing to do when there are no aircraft, and records it', async () => {
    expect(await backfillAircraftPhotos(db, { fetchAircraft: vi.fn(), pause })).toBe(0)
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeDefined()
  })

  it('keeps going past a failed lookup, does not record the pass, and next time asks only about what is still missing', async () => {
    createAircraft(db, { registration: 'G-DOWN', icaoType: 'A320' })
    createAircraft(db, { registration: 'G-FINE', icaoType: 'A320' })
    const flaky = vi.fn(async (registration: string) => {
      if (registration === 'G-DOWN') throw new Error('adsbdb lookup failed (HTTP 503)')
      return found()
    })
    expect(await backfillAircraftPhotos(db, { fetchAircraft: flaky, pause })).toBe(1)
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeUndefined()
    expect(listAircraft(db).map((a) => [a.registration, a.photoUrl])).toEqual([
      ['G-DOWN', null],
      ['G-FINE', FULL]
    ])

    const retry = vi.fn(async () => found())
    expect(await backfillAircraftPhotos(db, { fetchAircraft: retry, pause })).toBe(1)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('G-DOWN')
    expect(getSetting(db, PHOTO_BACKFILL_DONE_KEY)).toBeDefined()
  })
})
