import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  LATEST_RELEASE_URL,
  UpdateService,
  compareVersions,
  parseLatestRelease,
  parseVersion
} from './update-check'

// The fields GitHub's /releases/latest actually returns for a WingLog release (trimmed).
const RELEASE_1_4_0 = {
  tag_name: 'v1.4.0',
  name: 'WingLog 1.4.0',
  html_url: 'https://github.com/Catalyst4K/WingLog/releases/tag/v1.4.0',
  body: '## New\n- BeyondATC integration',
  draft: false,
  prerelease: false,
  published_at: '2026-10-04T18:00:00Z'
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeService(options: { currentVersion?: string; fetchImpl?: typeof fetch; enabled?: boolean; skipped?: string | null } = {}): {
  service: UpdateService
  setSkipped: ReturnType<typeof vi.fn>
  fetchImpl: ReturnType<typeof vi.fn>
} {
  const fetchImpl = vi.fn(options.fetchImpl ?? (async () => jsonResponse(RELEASE_1_4_0)))
  const setSkipped = vi.fn()
  const service = new UpdateService({
    currentVersion: options.currentVersion ?? '1.3.2',
    isEnabled: () => options.enabled ?? true,
    getSkippedVersion: () => options.skipped ?? null,
    setSkippedVersion: setSkipped,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    log: () => {}
  })
  return { service, setSkipped, fetchImpl }
}

describe('parseVersion / compareVersions', () => {
  it('reads real release tags, with or without the v', () => {
    expect(parseVersion('v1.3.2')).toEqual([1, 3, 2])
    expect(parseVersion('1.4.0')).toEqual([1, 4, 0])
    expect(parseVersion('v1.0.0-beta.1')).toBeNull() // we don't publish prereleases
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion(140)).toBeNull()
  })

  it('compares numerically, not as text', () => {
    expect(compareVersions([1, 4, 0], [1, 3, 2])).toBeGreaterThan(0)
    expect(compareVersions([1, 10, 0], [1, 9, 3])).toBeGreaterThan(0)
    expect(compareVersions([1, 3, 2], [1, 3, 2])).toBe(0)
    expect(compareVersions([1, 3, 2], [2, 0, 0])).toBeLessThan(0)
  })
})

describe('parseLatestRelease (GitHub data is third-party input)', () => {
  it('keeps only the fields WingLog uses', () => {
    expect(parseLatestRelease(RELEASE_1_4_0)).toEqual({
      version: '1.4.0',
      url: 'https://github.com/Catalyst4K/WingLog/releases/tag/v1.4.0',
      notes: '## New\n- BeyondATC integration',
      publishedAt: '2026-10-04T18:00:00Z'
    })
  })

  it('rejects a release page anywhere but WingLog\'s own releases', () => {
    expect(parseLatestRelease({ ...RELEASE_1_4_0, html_url: 'https://evil.example.com/WingLog-1.4.0.exe' })).toBeNull()
    expect(parseLatestRelease({ ...RELEASE_1_4_0, html_url: 'http://github.com/Catalyst4K/WingLog/releases/tag/v1.4.0' })).toBeNull()
    expect(parseLatestRelease({ ...RELEASE_1_4_0, html_url: 'https://github.com/someone-else/WingLog/releases/tag/v1.4.0' })).toBeNull()
  })

  it('rejects drafts, prereleases, odd tags and non-objects', () => {
    expect(parseLatestRelease({ ...RELEASE_1_4_0, draft: true })).toBeNull()
    expect(parseLatestRelease({ ...RELEASE_1_4_0, prerelease: true })).toBeNull()
    expect(parseLatestRelease({ ...RELEASE_1_4_0, tag_name: 'nightly' })).toBeNull()
    expect(parseLatestRelease(null)).toBeNull()
    expect(parseLatestRelease('v1.4.0')).toBeNull()
  })

  it('keeps notes as text, capped, and tolerates missing optional fields', () => {
    const script = '<script>alert(1)</script>'
    expect(parseLatestRelease({ ...RELEASE_1_4_0, body: script })?.notes).toBe(script)
    expect(parseLatestRelease({ ...RELEASE_1_4_0, body: 'x'.repeat(50_000) })?.notes).toHaveLength(20_000)
    expect(parseLatestRelease({ ...RELEASE_1_4_0, body: null, published_at: undefined })).toMatchObject({ notes: '', publishedAt: null })
  })
})

describe('UpdateService', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a newer release as available, asking only GitHub with WingLog\'s version', async () => {
    const { service, fetchImpl } = makeService()
    const statuses: string[] = []
    service.on('status', (s) => statuses.push(s.state))

    const status = await service.checkNow()

    expect(status).toMatchObject({ state: 'available', currentVersion: '1.3.2', latest: { version: '1.4.0' } })
    expect(status.checkedAt).not.toBeNull()
    expect(statuses).toEqual(['checking', 'available'])
    expect(fetchImpl).toHaveBeenCalledWith(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WingLog/1.3.2' }
    })
    expect(service.releaseUrl()).toBe('https://github.com/Catalyst4K/WingLog/releases/tag/v1.4.0')
  })

  it('is up to date on the same or an older release', async () => {
    expect((await makeService({ currentVersion: '1.4.0' }).service.checkNow()).state).toBe('upToDate')
    expect((await makeService({ currentVersion: '1.5.0' }).service.checkNow()).state).toBe('upToDate')
  })

  it('never throws: offline, rate-limited and malformed replies end as an error state', async () => {
    const offline = makeService({ fetchImpl: async () => Promise.reject(new TypeError('fetch failed')) })
    expect((await offline.service.checkNow()).state).toBe('error')
    const limited = makeService({ fetchImpl: async () => jsonResponse({ message: 'API rate limit exceeded' }, 403) })
    expect((await limited.service.checkNow()).state).toBe('error')
    const odd = makeService({ fetchImpl: async () => jsonResponse({ tag_name: 'v9.9.9', html_url: 'https://evil.example.com' }) })
    expect((await odd.service.checkNow()).state).toBe('error')
    expect(odd.service.releaseUrl()).toBeNull()
  })

  it('skips only the version GitHub actually offered, and remembers it', async () => {
    const { service, setSkipped } = makeService()
    await service.checkNow()
    service.skipVersion('9.9.9')
    service.skipVersion({ version: '1.4.0' })
    expect(setSkipped).not.toHaveBeenCalled()
    service.skipVersion('1.4.0')
    expect(setSkipped).toHaveBeenCalledWith('1.4.0')
    expect(service.getStatus().skippedVersion).toBe('1.4.0')
  })

  it('starts with the remembered skipped version', () => {
    expect(makeService({ skipped: '1.4.0' }).service.getStatus().skippedVersion).toBe('1.4.0')
  })

  it('checks 30 s after launch and every 6 hours, and not at all while switched off', async () => {
    vi.useFakeTimers()
    const on = makeService()
    on.service.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1)
    expect(on.fetchImpl).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(on.fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(on.fetchImpl).toHaveBeenCalledTimes(2)
    on.service.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(on.fetchImpl).toHaveBeenCalledTimes(2)

    const off = makeService({ enabled: false })
    off.service.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(off.fetchImpl).not.toHaveBeenCalled()
    // "Check now" still works with the automatic check off.
    await off.service.checkNow()
    expect(off.fetchImpl).toHaveBeenCalledTimes(1)
    off.service.stop()
  })
})
