import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLANESPOTTERS_URL, fetchPlanespottersPhoto } from './planespotters-client'

// Captured live from https://api.planespotters.net/pub/photos/reg/G-EZTK.
const REAL_REPLY = {
  photos: [
    {
      id: '1947470',
      thumbnail: {
        src: 'https://t.plnspttrs.net/00978/1947470_54b1bd86b7_t.jpg',
        size: { width: 200, height: 133 }
      },
      thumbnail_large: {
        src: 'https://t.plnspttrs.net/00978/1947470_54b1bd86b7_280.jpg',
        size: { width: 420, height: 280 }
      },
      link: 'https://www.planespotters.net/photo/1947470/g-eztk-easyjet-airbus-a320-214?utm_source=api',
      photographer: 'John Robert Murdoch'
    }
  ]
}

function reply(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
}

describe('fetchPlanespottersPhoto', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the 420 px photo, its photographer and its page, as the service gave them', async () => {
    vi.stubGlobal('fetch', reply(REAL_REPLY))
    expect(await fetchPlanespottersPhoto('G-EZTK', 'WingLog/1.7.0')).toEqual({
      photoUrl: 'https://t.plnspttrs.net/00978/1947470_54b1bd86b7_280.jpg',
      photographer: 'John Robert Murdoch',
      pageUrl: 'https://www.planespotters.net/photo/1947470/g-eztk-easyjet-airbus-a320-214?utm_source=api'
    })
  })

  it('names WingLog in the User-Agent, as its terms ask, and encodes the registration', async () => {
    const fetchMock = reply({ photos: [] })
    vi.stubGlobal('fetch', fetchMock)
    await fetchPlanespottersPhoto('G-A/B C', 'WingLog/1.7.0')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${PLANESPOTTERS_URL}/G-A%2FB%20C`)
    expect(init.headers).toMatchObject({ 'User-Agent': 'WingLog/1.7.0' })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('answers null, not an error, when it has no photo for the aircraft', async () => {
    vi.stubGlobal('fetch', reply({ photos: [] }))
    expect(await fetchPlanespottersPhoto('N12345', 'WingLog')).toBeNull()
  })

  it.each([
    ['a photo on another host', { thumbnail_large: { src: 'https://evil.example/a.jpg' } }],
    ['a photo that is not https', { thumbnail_large: { src: 'http://t.plnspttrs.net/a.jpg' } }],
    ['a photo with no image', { thumbnail_large: undefined }],
    ['a page on another host', { link: 'https://evil.example/photo/1' }],
    ['a script as the page', { link: 'javascript:alert(1)' }],
    ['no photographer', { photographer: undefined }],
    ['a blank photographer', { photographer: '   ' }],
    ['a photographer with control characters', { photographer: 'Eve\u0007\nLog' }],
    ['a photographer that is not text', { photographer: 42 }]
  ])('treats %s as no photo', async (_label, change) => {
    vi.stubGlobal('fetch', reply({ photos: [{ ...REAL_REPLY.photos[0], ...change }] }))
    expect(await fetchPlanespottersPhoto('G-EZTK', 'WingLog')).toBeNull()
  })

  it('trims the photographer’s name', async () => {
    vi.stubGlobal(
      'fetch',
      reply({ photos: [{ ...REAL_REPLY.photos[0], photographer: '  Björn Wylezich ' }] })
    )
    expect((await fetchPlanespottersPhoto('G-EUYD', 'WingLog'))?.photographer).toBe('Björn Wylezich')
  })

  it.each([
    ['a rate-limit refusal', 403, { error: 'blocked' }],
    ['a server error', 503, undefined],
    ['a reply that is not the expected shape', 200, { unexpected: true }]
  ])('throws on %s, so a pass can tell it from "no photo"', async (_label, status, body) => {
    vi.stubGlobal('fetch', reply(body, status))
    await expect(fetchPlanespottersPhoto('G-EZTK', 'WingLog')).rejects.toThrow(/Planespotters lookup failed/)
  })

  it('throws when the reply is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        }
      }))
    )
    await expect(fetchPlanespottersPhoto('G-EZTK', 'WingLog')).rejects.toThrow(/Planespotters lookup failed/)
  })
})
