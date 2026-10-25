import { describe, expect, it } from 'vitest'
import { feedUserAgent, REAL_FEED_URLS, resolveFeedUrls, VATSIM_DATA_URL, vatsimDataUrl } from './feed-urls'

describe('vatsimDataUrl', () => {
  it('takes data.v3[0] from the status page', () => {
    expect(vatsimDataUrl({ data: { v3: ['https://data.vatsim.net/v3/vatsim-data.json'] } })).toBe(
      VATSIM_DATA_URL
    )
  })

  it.each([
    ['a different host', 'https://evil.example/v3/vatsim-data.json'],
    ['a look-alike host', 'https://data.vatsim.net.evil.example/x'],
    ['a plain http address', 'http://data.vatsim.net/v3/vatsim-data.json'],
    ['a file address', 'file:///etc/passwd'],
    ['a javascript address', 'javascript:alert(1)'],
    ['an address with a login in it', 'https://data.vatsim.net@evil.example/x'],
    ['a login before the real host', 'https://user:pw@data.vatsim.net/x'],
    ['text that is not an address', 'not a url']
  ])('refuses %s', (_name, url) => {
    expect(vatsimDataUrl({ data: { v3: [url] } })).toBeNull()
  })

  it.each([
    null,
    undefined,
    5,
    'x',
    {},
    { data: null },
    { data: {} },
    { data: { v3: 'x' } },
    { data: { v3: [] } },
    { data: { v3: [5] } }
  ])('is null for %j', (status) => {
    expect(vatsimDataUrl(status)).toBeNull()
  })
})

describe('feedUserAgent', () => {
  it('names the app, its version and its page', () => {
    expect(feedUserAgent('1.6.0')).toBe('WingLog/1.6.0 (+https://github.com/Catalyst4K/WingLog)')
  })
})

describe('resolveFeedUrls', () => {
  const env = {
    WINGLOG_E2E_VATSIM_URL: 'http://127.0.0.1:9/vatsim',
    WINGLOG_E2E_IVAO_URL: 'http://127.0.0.1:9/ivao'
  }

  it('uses the real addresses, https only', () => {
    expect(REAL_FEED_URLS.vatsimData.startsWith('https:')).toBe(true)
    expect(REAL_FEED_URLS.vatsimStatus?.startsWith('https:')).toBe(true)
    expect(REAL_FEED_URLS.ivao.startsWith('https:')).toBe(true)
  })

  it('ignores the test overrides in a packaged app', () => {
    expect(resolveFeedUrls(true, env)).toEqual(REAL_FEED_URLS)
  })

  it('honours them in an unpackaged app, skipping the status page for VATSIM', () => {
    expect(resolveFeedUrls(false, env)).toEqual({
      vatsimStatus: null,
      vatsimData: 'http://127.0.0.1:9/vatsim',
      ivao: 'http://127.0.0.1:9/ivao'
    })
  })

  it('uses the real addresses in an unpackaged app with nothing set', () => {
    expect(resolveFeedUrls(false, {})).toEqual(REAL_FEED_URLS)
  })
})
