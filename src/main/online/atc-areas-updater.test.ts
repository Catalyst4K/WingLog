import { describe, expect, it, vi } from 'vitest'
import { parseAreaData, type AreaData } from './atc-areas'
import type { Release, Releases } from './atc-areas-download'
import {
  AtcAreasUpdater,
  CHECK_EVERY_MS,
  FIRST_CHECK_DELAY_MS,
  TICK_MS,
  type AtcAreasUpdaterDeps
} from './atc-areas-updater'

const RING = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0]
]

/** An area file with `count` centres and `count` approaches, from the given releases. */
function areaFile(vatspy: string, tracon: string, count = 150): string {
  const firs: Record<string, object> = {}
  for (let i = 0; i < count; i++) firs[`F${i}`] = { name: `Area ${i}`, at: [0.5, 0.5], coordinates: [[RING]] }
  const approaches = Array.from({ length: count }, (_, i) => ({
    id: `A${i}`,
    prefix: [`P${i}`],
    suffix: 'APP',
    name: `Approach ${i}`,
    at: [0.5, 0.5],
    coordinates: [[RING]]
  }))
  return JSON.stringify({
    sources: { vatspy, tracon },
    prefixes: {},
    icaoBoundaries: {},
    uirs: {},
    firs,
    approaches
  })
}

const BUNDLED_TEXT = areaFile('v2610.1', 'v1.2.13')
const BUNDLED = parseAreaData(BUNDLED_TEXT) as AreaData

const release = (tag: string): Release => ({ tag, asset: async () => '' })
const releases = (vatspy: string, tracon: string): Releases => ({
  vatspy: release(vatspy),
  tracon: release(tracon)
})

const NOW = new Date('2026-11-05T12:00:00Z')

interface Harness {
  updater: AtcAreasUpdater
  deps: AtcAreasUpdaterDeps
  written: string[]
  state: { copy: string | null; auto: boolean; checkedAt: string | null; network: boolean; now: Date }
  latest: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  logged: string[]
  timers: { callbacks: { callback: () => void; ms: number }[]; cleared: unknown[] }
}

function harness(
  options: {
    bundled?: AreaData | null
    copy?: string | null
    latest?: Releases
    downloaded?: string
    auto?: boolean
    checkedAt?: string | null
    network?: boolean
  } = {}
): Harness {
  const state = {
    copy: options.copy ?? null,
    auto: options.auto ?? true,
    checkedAt: options.checkedAt ?? null,
    network: options.network ?? true,
    now: NOW
  }
  const written: string[] = []
  const logged: string[] = []
  const timers: Harness['timers'] = { callbacks: [], cleared: [] }
  const latest = vi.fn(async () => options.latest ?? releases('v2610.1', 'v1.2.13'))
  const download = vi.fn(async () => options.downloaded ?? areaFile('v2611.1', 'v1.2.13'))
  const deps: AtcAreasUpdaterDeps = {
    bundled: () => (options.bundled === undefined ? BUNDLED : options.bundled),
    file: {
      read: () => state.copy,
      write: (text) => {
        written.push(text)
        state.copy = text
      }
    },
    settings: {
      auto: () => state.auto,
      setAuto: (on) => (state.auto = on),
      checkedAt: () => state.checkedAt,
      setCheckedAt: (iso) => (state.checkedAt = iso)
    },
    networkChosen: () => state.network,
    latestReleases: latest,
    download,
    now: () => state.now,
    timers: {
      set: (callback, ms) => {
        timers.callbacks.push({ callback, ms })
        return timers.callbacks.length
      },
      clear: (handle) => timers.cleared.push(handle)
    },
    log: { info: (message) => logged.push(message) }
  }
  return { updater: new AtcAreasUpdater(deps), deps, written, state, latest, download, logged, timers }
}

describe('the areas in use', () => {
  it('are the bundled ones when the app has made no copy of its own', () => {
    const { updater } = harness()
    expect(updater.current()).toBe(BUNDLED)
    expect(updater.status()).toMatchObject({ source: 'bundled', vatspy: 'v2610.1', tracon: 'v1.2.13' })
  })

  it('are the app’s own copy once it is newer than the bundled one', () => {
    const { updater } = harness({ copy: areaFile('v2611.1', 'v1.2.13') })
    expect(updater.status()).toMatchObject({ source: 'downloaded', vatspy: 'v2611.1', tracon: 'v1.2.13' })
  })

  it('go back to the bundled ones when an app update ships data as new as the copy, or newer', () => {
    expect(harness({ copy: areaFile('v2610.1', 'v1.2.13') }).updater.status().source).toBe('bundled')
    expect(harness({ copy: areaFile('v2609.2', 'v1.2.13') }).updater.status().source).toBe('bundled')
  })

  it('ignore a copy that is newer in one project and older in the other, or whose tags cannot be read', () => {
    expect(harness({ copy: areaFile('v2611.1', 'v1.2.12') }).updater.status().source).toBe('bundled')
    expect(harness({ copy: areaFile('latest', 'v1.2.13') }).updater.status().source).toBe('bundled')
  })

  it('ignore a copy that is damaged, empty or has too few areas', () => {
    expect(harness({ copy: 'not json' }).updater.status().source).toBe('bundled')
    expect(harness({ copy: areaFile('v2611.1', 'v1.2.13', 20) }).updater.status().source).toBe('bundled')
  })

  it('are the copy when the bundled file cannot be read at all, however old, and none when neither can', () => {
    expect(harness({ bundled: null, copy: areaFile('v2611.1', 'v1.2.13') }).updater.status().source).toBe(
      'downloaded'
    )
    const none = harness({ bundled: null })
    expect(none.updater.current()).toBeNull()
    expect(none.updater.status()).toMatchObject({ source: 'bundled', vatspy: '', tracon: '' })
  })

  it('report the switch and when GitHub was last asked', () => {
    const { updater } = harness({ auto: false, checkedAt: '2026-11-01T00:00:00.000Z' })
    expect(updater.status()).toMatchObject({ auto: false, checkedAt: '2026-11-01T00:00:00.000Z' })
  })
})

describe('the switch', () => {
  it('is saved, and shown at once', () => {
    const { updater, state } = harness()
    expect(updater.setAuto(false).auto).toBe(false)
    expect(state.auto).toBe(false)
    expect(updater.setAuto(true).auto).toBe(true)
  })
})

describe('a scheduled check', () => {
  it('asks GitHub the first time, with a network chosen and the switch on', async () => {
    const { updater, latest, state } = harness({ latest: releases('v2610.1', 'v1.2.13') })
    const result = await updater.check(false)
    expect(latest).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('current')
    expect(state.checkedAt).toBe(NOW.toISOString())
  })

  it('makes no request with no network chosen, with the switch off, or within a week of the last check', async () => {
    const quiet = [
      harness({ network: false }),
      harness({ auto: false }),
      harness({ checkedAt: new Date(NOW.getTime() - CHECK_EVERY_MS + 60_000).toISOString() })
    ]
    for (const { updater, latest } of quiet) {
      expect((await updater.check(false)).outcome).toBe('skipped')
      expect(latest).not.toHaveBeenCalled()
    }
  })

  it('asks again once a week has passed, and also when the last time is not a time', async () => {
    const week = harness({ checkedAt: new Date(NOW.getTime() - CHECK_EVERY_MS).toISOString() })
    expect((await week.updater.check(false)).outcome).toBe('current')
    const odd = harness({ checkedAt: 'sometime' })
    expect((await odd.updater.check(false)).outcome).toBe('current')
  })
})

describe('Check now', () => {
  it('ignores the switch, the week and whether a network is chosen', async () => {
    const { updater, latest } = harness({
      auto: false,
      network: false,
      checkedAt: NOW.toISOString()
    })
    expect((await updater.check(true)).outcome).toBe('current')
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('downloads, keeps and uses a newer release', async () => {
    const { updater, written, download, state } = harness({ latest: releases('v2611.1', 'v1.2.13') })
    const result = await updater.check(true)
    expect(result.outcome).toBe('updated')
    expect(download).toHaveBeenCalledTimes(1)
    expect(written).toEqual([areaFile('v2611.1', 'v1.2.13')])
    expect(result.status).toMatchObject({
      source: 'downloaded',
      vatspy: 'v2611.1',
      checkedAt: NOW.toISOString()
    })
    expect(updater.current()?.sources.vatspy).toBe('v2611.1')
    expect(state.copy).toBe(written[0])
  })

  it('updates when only the other project has a newer release', async () => {
    const { updater } = harness({
      latest: releases('v2610.1', 'v1.2.14'),
      downloaded: areaFile('v2610.1', 'v1.2.14')
    })
    expect((await updater.check(true)).outcome).toBe('updated')
    expect(updater.status().tracon).toBe('v1.2.14')
  })

  it('downloads nothing when the releases are the ones in use, or older', async () => {
    const same = harness({ latest: releases('v2610.1', 'v1.2.13') })
    await same.updater.check(true)
    const older = harness({ latest: releases('v2609.2', 'v1.2.12') })
    await older.updater.check(true)
    expect(same.download).not.toHaveBeenCalled()
    expect(older.download).not.toHaveBeenCalled()
  })

  it('downloads nothing more once the copy in use is the newest', async () => {
    const { updater, download } = harness({
      copy: areaFile('v2611.1', 'v1.2.13'),
      latest: releases('v2611.1', 'v1.2.13')
    })
    expect((await updater.check(true)).outcome).toBe('current')
    expect(download).not.toHaveBeenCalled()
  })

  it('replaces a copy of its own with a still newer one', async () => {
    const { updater, written } = harness({
      copy: areaFile('v2611.1', 'v1.2.13'),
      latest: releases('v2612.1', 'v1.2.13'),
      downloaded: areaFile('v2612.1', 'v1.2.13')
    })
    expect((await updater.check(true)).outcome).toBe('updated')
    expect(written).toHaveLength(1)
    expect(updater.status().vatspy).toBe('v2612.1')
  })

  it('treats a release tag it cannot compare as newer, so a bad held tag is replaced', async () => {
    const odd = parseAreaData(areaFile('', '', 150)) as AreaData
    const { updater } = harness({
      bundled: odd,
      latest: releases('v2610.1', 'v1.2.13'),
      downloaded: areaFile('v2610.1', 'v1.2.13')
    })
    expect((await updater.check(true)).outcome).toBe('updated')
  })

  it('updates when nothing at all is in use', async () => {
    const { updater } = harness({
      bundled: null,
      latest: releases('v2610.1', 'v1.2.13'),
      downloaded: areaFile('v2610.1', 'v1.2.13')
    })
    expect((await updater.check(true)).outcome).toBe('updated')
    expect(updater.current()).not.toBeNull()
  })

  it.each([
    ['what came down is not an area file', 'not json'],
    ['it holds far too few areas', areaFile('v2611.1', 'v1.2.13', 10)],
    ['it holds half as many areas as before', areaFile('v2611.1', 'v1.2.13', 60)]
  ])('keeps what is in use when %s', async (_label, downloaded) => {
    const { updater, written, logged, state } = harness({
      latest: releases('v2611.1', 'v1.2.13'),
      downloaded
    })
    const result = await updater.check(true)
    expect(result.outcome).toBe('failed')
    expect(written).toEqual([])
    expect(updater.current()).toBe(BUNDLED)
    expect(logged[0]).toContain('not usable')
    expect(state.checkedAt).toBeNull()
  })

  it('keeps what is in use, and says "current", when what came down is not newer after all', async () => {
    const { updater, written } = harness({
      latest: releases('v2611.1', 'v1.2.13'),
      downloaded: areaFile('v2610.1', 'v1.2.13')
    })
    expect((await updater.check(true)).outcome).toBe('current')
    expect(written).toEqual([])
  })

  it('fails, logs and leaves everything alone when GitHub cannot be reached', async () => {
    const { updater, latest, logged, state } = harness()
    latest.mockRejectedValue(new Error('offline'))
    const result = await updater.check(true)
    expect(result.outcome).toBe('failed')
    expect(logged[0]).toContain('offline')
    expect(state.checkedAt).toBeNull()
    expect(updater.current()).toBe(BUNDLED)
  })

  it('fails and keeps what it had when the copy cannot be written', async () => {
    const { updater, deps, logged } = harness({ latest: releases('v2611.1', 'v1.2.13') })
    deps.file.write = () => {
      throw new Error('disk full')
    }
    expect((await updater.check(true)).outcome).toBe('failed')
    expect(logged[0]).toContain('disk full')
    expect(updater.current()).toBe(BUNDLED)
  })

  it('does not run two checks at once: a second asks the same one', async () => {
    const { updater, latest } = harness()
    const [first, second] = await Promise.all([updater.check(true), updater.check(true)])
    expect(latest).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    await updater.check(true)
    expect(latest).toHaveBeenCalledTimes(2)
  })
})

describe('the schedule', () => {
  it('looks a minute after launch, then every day, and each look checks only when one is due', async () => {
    const { updater, timers, latest } = harness()
    updater.start()
    expect(timers.callbacks.map((t) => t.ms)).toEqual([FIRST_CHECK_DELAY_MS])
    timers.callbacks[0]?.callback()
    await vi.waitFor(() => expect(latest).toHaveBeenCalledTimes(1))
    expect(timers.callbacks.map((t) => t.ms)).toEqual([FIRST_CHECK_DELAY_MS, TICK_MS])
    timers.callbacks[1]?.callback()
    await Promise.resolve()
    expect(latest).toHaveBeenCalledTimes(1)
  })

  it('stops, and a stop with nothing started does nothing', () => {
    const { updater, timers } = harness()
    updater.stop()
    expect(timers.cleared).toEqual([])
    updater.start()
    updater.stop()
    expect(timers.cleared).toEqual([1])
  })

  it('logs and carries on if a scheduled check ever throws', async () => {
    const { updater, deps, timers, logged } = harness()
    deps.settings.auto = () => {
      throw new Error('settings broke')
    }
    updater.start()
    timers.callbacks[0]?.callback()
    await vi.waitFor(() => expect(logged[0]).toContain('settings broke'))
    expect(timers.callbacks).toHaveLength(2)
  })
})
