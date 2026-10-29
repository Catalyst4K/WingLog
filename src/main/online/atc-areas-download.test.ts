import { describe, expect, it, vi } from 'vitest'
import {
  REAL_AREA_SOURCE,
  TRACON_REPO,
  VATSPY_REPO,
  compareTags,
  downloadAreaFile,
  latestReleases,
  resolveAreaSource,
  tagParts,
  type AreaSource,
  type FetchImpl
} from './atc-areas-download'

const GOOD_HOST = 'https://github.com/vatsimnetwork/x/releases/download'

/** A fake GitHub: the release JSON for each repository, and the text of each file by address. */
function fakeGithub(options: {
  vatspyTag?: string
  traconTag?: string
  assetBase?: string
  bodies?: Record<string, string | Response>
  release?: (repo: string) => unknown
}): { fetchImpl: FetchImpl; requested: string[] } {
  const base = options.assetBase ?? GOOD_HOST
  const requested: string[] = []
  const names: Record<string, string[]> = {
    [VATSPY_REPO]: ['VATSpy.dat', 'Boundaries.geojson'],
    [TRACON_REPO]: ['TRACONBoundaries.geojson']
  }
  const fetchImpl: FetchImpl = async (url) => {
    requested.push(url)
    for (const repo of [VATSPY_REPO, TRACON_REPO]) {
      if (url.endsWith(`/repos/${repo}/releases/latest`)) {
        const tag = repo === VATSPY_REPO ? (options.vatspyTag ?? 'v2610.1') : (options.traconTag ?? 'v1.2.13')
        const json = options.release?.(repo) ?? {
          tag_name: tag,
          assets: names[repo].map((name) => ({ name, browser_download_url: `${base}/${tag}/${name}` }))
        }
        return new Response(JSON.stringify(json))
      }
    }
    const body = options.bodies?.[url]
    if (body instanceof Response) return body
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body)
  }
  return { fetchImpl, requested }
}

const AGENT = 'WingLog/1.6.0 (+https://github.com/Catalyst4K/WingLog)'

describe('tagParts and compareTags', () => {
  it('reads both projects’ tag styles', () => {
    expect(tagParts('v2610.1')).toEqual([2610, 1])
    expect(tagParts('v1.2.13')).toEqual([1, 2, 13])
  })

  it.each([[undefined], [5], [''], ['2610.1'], ['v2610'], ['v1.2.13-beta'], ['v1.2.3.4.5'], ['v1..2']])(
    'does not read %j as a release tag',
    (value) => {
      expect(tagParts(value)).toBeNull()
    }
  )

  it('orders tags by their numbers, not as text', () => {
    expect(compareTags('v1.2.13', 'v1.2.9')).toBeGreaterThan(0)
    expect(compareTags('v2609.2', 'v2610.1')).toBeLessThan(0)
    expect(compareTags('v2610.1', 'v2610.1')).toBe(0)
    expect(compareTags('v2610.1', 'v2610.1.0')).toBe(0)
  })

  it('says nothing when either side is not a tag', () => {
    expect(compareTags('', 'v2610.1')).toBeNull()
    expect(compareTags('v2610.1', 'latest')).toBeNull()
  })
})

describe('resolveAreaSource', () => {
  it('is GitHub in a packaged app, whatever the environment says', () => {
    expect(resolveAreaSource(true, { WINGLOG_E2E_ATC_AREAS_URL: 'http://127.0.0.1:9' })).toBe(
      REAL_AREA_SOURCE
    )
  })

  it('is GitHub unpackaged without the override', () => {
    expect(resolveAreaSource(false, {})).toBe(REAL_AREA_SOURCE)
  })

  it('is the test’s own server on this machine for the unpackaged override, and only that host, without a trailing slash', () => {
    const source = resolveAreaSource(false, { WINGLOG_E2E_ATC_AREAS_URL: 'http://127.0.0.1:5000/' })
    expect(source).toEqual({
      apiBase: 'http://127.0.0.1:5000',
      assetHosts: new Set(['127.0.0.1']),
      allowHttp: true
    })
  })
})

describe('latestReleases', () => {
  it('asks GitHub for each project’s latest release with WingLog’s own User-Agent, and nothing else', async () => {
    const { fetchImpl, requested } = fakeGithub({})
    const spy = vi.fn(fetchImpl)
    const releases = await latestReleases(REAL_AREA_SOURCE, spy, AGENT)
    expect(releases.vatspy.tag).toBe('v2610.1')
    expect(releases.tracon.tag).toBe('v1.2.13')
    expect(requested).toEqual([
      `https://api.github.com/repos/${VATSPY_REPO}/releases/latest`,
      `https://api.github.com/repos/${TRACON_REPO}/releases/latest`
    ])
    expect(spy.mock.calls[0]?.[1].headers).toEqual({ 'User-Agent': AGENT })
  })

  it.each([
    ['a failed request', () => ({ status: 500 })],
    ['a tag that is not a release tag', () => ({ tag_name: 'latest', assets: [] })],
    ['a draft', () => ({ tag_name: 'v2610.1', draft: true, assets: [] })],
    ['a prerelease', () => ({ tag_name: 'v2610.1', prerelease: true, assets: [] })],
    ['no list of files', () => ({ tag_name: 'v2610.1' })]
  ])('refuses %s', async (_label, make) => {
    const bad = make()
    const fetchImpl: FetchImpl = async () =>
      'status' in bad ? new Response('x', { status: bad.status }) : new Response(JSON.stringify(bad))
    await expect(latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)).rejects.toThrow()
  })

  it('refuses a release JSON that is not JSON', async () => {
    const fetchImpl: FetchImpl = async () => new Response('<html>rate limited</html>')
    await expect(latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)).rejects.toThrow()
  })
})

describe('a release file', () => {
  const address = (tag: string, name: string): string => `${GOOD_HOST}/${tag}/${name}`

  it('is read from GitHub’s own host', async () => {
    const { fetchImpl } = fakeGithub({ bodies: { [address('v2610.1', 'VATSpy.dat')]: 'dat text' } })
    const { vatspy } = await latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)
    await expect(vatspy.asset('VATSpy.dat')).resolves.toBe('dat text')
  })

  it.each([
    ['a host that is not GitHub’s', 'https://evil.example/files', /not on an allowed host/],
    ['plain http', 'http://github.com/files', /no usable/],
    ['a file: address', 'file:///C:/secret.txt', /no usable/]
  ])('is refused from %s', async (_label, base, reason) => {
    const { fetchImpl, requested } = fakeGithub({ assetBase: base })
    const { vatspy } = await latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)
    await expect(vatspy.asset('VATSpy.dat')).rejects.toThrow(reason)
    expect(requested.some((url) => !url.startsWith('https://api.github.com'))).toBe(false)
  })

  it('is refused when the address carries a name and password', async () => {
    const { fetchImpl } = fakeGithub({ assetBase: 'https://user:pass@github.com/files' })
    const { vatspy } = await latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)
    await expect(vatspy.asset('VATSpy.dat')).rejects.toThrow(/allowed host/)
  })

  it('is refused when the release does not list it, or lists it with an address that is not one', async () => {
    const { fetchImpl } = fakeGithub({
      release: () => ({
        tag_name: 'v2610.1',
        assets: [{ name: 'Other.dat', browser_download_url: 'not a url' }]
      })
    })
    const { vatspy } = await latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)
    await expect(vatspy.asset('VATSpy.dat')).rejects.toThrow(/no usable/)
    const odd = fakeGithub({
      release: () => ({
        tag_name: 'v2610.1',
        assets: [{ name: 'VATSpy.dat', browser_download_url: 'not a url' }]
      })
    })
    const again = await latestReleases(REAL_AREA_SOURCE, odd.fetchImpl, AGENT)
    await expect(again.vatspy.asset('VATSpy.dat')).rejects.toThrow(/no usable/)
  })

  it('is refused when the server answers with an error', async () => {
    const { fetchImpl } = fakeGithub({})
    const { vatspy } = await latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)
    await expect(vatspy.asset('VATSpy.dat')).rejects.toThrow('HTTP 404')
  })

  it('is refused when it says it is too big, and when it turns out to be, without reading on', async () => {
    const declared = new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } })
    const big = new Response('y'.repeat(9 * 1024 * 1024))
    const small = fakeGithub({ bodies: { [address('v2610.1', 'VATSpy.dat')]: declared } })
    const first = await latestReleases(REAL_AREA_SOURCE, small.fetchImpl, AGENT)
    await expect(first.vatspy.asset('VATSpy.dat')).rejects.toThrow('too large')
    const stream = fakeGithub({ bodies: { [address('v2610.1', 'VATSpy.dat')]: big } })
    const second = await latestReleases(REAL_AREA_SOURCE, stream.fetchImpl, AGENT)
    await expect(second.vatspy.asset('VATSpy.dat')).rejects.toThrow('too large')
  })

  it('reads an empty body as empty text', async () => {
    const empty = new Response(null)
    const { fetchImpl } = fakeGithub({ bodies: { [address('v2610.1', 'VATSpy.dat')]: empty } })
    const { vatspy } = await latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)
    await expect(vatspy.asset('VATSpy.dat')).resolves.toBe('')
  })

  it('may come from http on this machine only for the end-to-end test’s own source', async () => {
    const source: AreaSource = {
      apiBase: 'http://127.0.0.1:5000',
      assetHosts: new Set(['127.0.0.1']),
      allowHttp: true
    }
    const base = 'http://127.0.0.1:5000/files'
    const { fetchImpl } = fakeGithub({ assetBase: base, bodies: { [`${base}/v2610.1/VATSpy.dat`]: 'dat' } })
    const { vatspy } = await latestReleases(source, fetchImpl, AGENT)
    await expect(vatspy.asset('VATSpy.dat')).resolves.toBe('dat')
  })
})

describe('downloadAreaFile', () => {
  const DAT = '[FIRs]\r\nEGTT|London|||\r\n[UIRs]\r\n'
  const SHAPE = {
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0]
      ]
    ]
  }

  it('reads the three files and makes the area file, naming the releases', async () => {
    const files: Record<string, string> = {
      [`${GOOD_HOST}/v2610.1/VATSpy.dat`]: DAT,
      [`${GOOD_HOST}/v2610.1/Boundaries.geojson`]: JSON.stringify({
        features: [{ properties: { id: 'EGTT' }, geometry: SHAPE }]
      }),
      [`${GOOD_HOST}/v1.2.13/TRACONBoundaries.geojson`]: JSON.stringify({ features: [] })
    }
    const { fetchImpl } = fakeGithub({ bodies: files })
    const releases = await latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)
    const built = JSON.parse(await downloadAreaFile(releases)) as { sources: unknown; firs: object }
    expect(built.sources).toEqual({ vatspy: 'v2610.1', tracon: 'v1.2.13' })
    expect(Object.keys(built.firs)).toEqual(['EGTT'])
  })

  it('fails, and makes nothing, when one of the files cannot be read', async () => {
    const { fetchImpl } = fakeGithub({ bodies: { [`${GOOD_HOST}/v2610.1/VATSpy.dat`]: DAT } })
    const releases = await latestReleases(REAL_AREA_SOURCE, fetchImpl, AGENT)
    await expect(downloadAreaFile(releases)).rejects.toThrow('HTTP 404')
  })
})
