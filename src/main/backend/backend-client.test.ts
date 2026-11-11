import { afterEach, describe, expect, it, vi } from 'vitest'
import { signSimbriefRequest } from './backend-client'

const PARAMS = {
  origIcao: 'EGLL',
  destIcao: 'WSSS',
  type: 'A388',
  timestamp: 1788307200,
  outputPage: 'winglog.local/generate'
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signSimbriefRequest', () => {
  it('posts the params and returns the apicode from the response', async () => {
    const fetchMock = vi.fn<
      (
        url: string,
        init?: RequestInit
      ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
    >(async () => ({ ok: true, status: 200, json: async () => ({ apicode: 'abc123' }) }))
    vi.stubGlobal('fetch', fetchMock)

    const apicode = await signSimbriefRequest(PARAMS)

    expect(apicode).toBe('abc123')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.winglog.co.uk/simbrief/sign')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual(PARAMS)
  })

  it('surfaces the backend error message on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: 'rate limit exceeded' }) }))
    )

    await expect(signSimbriefRequest(PARAMS)).rejects.toThrow('rate limit exceeded')
  })

  it('falls back to a generic message if the error response has no body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('no body')
        }
      }))
    )

    await expect(signSimbriefRequest(PARAMS)).rejects.toThrow('SimBrief signing request failed (500)')
  })
})

describe('signSimbriefRequest, when the backend is slow or odd (audit L6)', () => {
  it('sends a signal that gives up, and says the backend did not answer when it does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          })
      )
    )

    await expect(signSimbriefRequest(PARAMS, 20)).rejects.toThrow('timed out: the backend did not answer')
  })

  it('passes any other failure to fetch on unchanged', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )

    await expect(signSimbriefRequest(PARAMS)).rejects.toThrow('fetch failed')
  })

  it.each([
    ['an answer with no apicode', {}],
    ['an apicode that is not text', { apicode: 5 }],
    ['an empty apicode', { apicode: '' }],
    ['an answer that is not an object', null]
  ])('refuses %s', async (_name, answer) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => answer }))
    )

    await expect(signSimbriefRequest(PARAMS)).rejects.toThrow('something unexpected')
  })

  it('refuses an answer that is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        }
      }))
    )

    await expect(signSimbriefRequest(PARAMS)).rejects.toThrow('something unexpected')
  })
})
