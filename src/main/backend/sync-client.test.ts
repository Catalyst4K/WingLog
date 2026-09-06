import { afterEach, describe, expect, it, vi } from 'vitest'
import { login, logout, syncPull, syncPush } from './sync-client'

function fetchMock(status: number, body: unknown) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>>(
    async () => ({ ok: status < 400, status, json: async () => body })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('login', () => {
  it('posts email/password and returns the session', async () => {
    const mock = fetchMock(200, { token: 'tok', expiresAt: '2026-10-01T00:00:00Z' })
    vi.stubGlobal('fetch', mock)

    const result = await login('callum@example.com', 'hunter22222222')

    expect(result).toEqual({ token: 'tok', expiresAt: '2026-10-01T00:00:00Z' })
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('https://flightdeck-backend.callum-jones5.workers.dev/auth/login')
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'callum@example.com', password: 'hunter22222222' })
  })

  it('surfaces the same message on wrong password or unknown account', async () => {
    vi.stubGlobal('fetch', fetchMock(401, { error: 'invalid email or password' }))
    await expect(login('callum@example.com', 'wrong')).rejects.toThrow('invalid email or password')
  })
})

describe('logout', () => {
  it('posts email/token', async () => {
    const mock = fetchMock(200, { ok: true })
    vi.stubGlobal('fetch', mock)

    await logout('callum@example.com', 'tok')

    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('https://flightdeck-backend.callum-jones5.workers.dev/auth/logout')
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'callum@example.com', token: 'tok' })
  })
})

describe('syncPull', () => {
  it('returns the rows from the response', async () => {
    const rows = [{ uuid: 'a', updatedAt: '2026-09-04T00:00:00Z', data: '{}' }]
    vi.stubGlobal('fetch', fetchMock(200, { rows }))

    const result = await syncPull('callum@example.com', 'tok', 'aircraft', null)

    expect(result).toEqual(rows)
  })

  it('surfaces a 401 as a thrown error, distinguishable from a network failure', async () => {
    vi.stubGlobal('fetch', fetchMock(401, { error: 'invalid or expired session' }))
    await expect(syncPull('callum@example.com', 'tok', 'aircraft', null)).rejects.toThrow('invalid or expired session')
  })
})

describe('syncPush', () => {
  it('posts the table and rows, returns upserted/rejected', async () => {
    const mock = fetchMock(200, { upserted: ['a'], rejected: ['b'] })
    vi.stubGlobal('fetch', mock)
    const rows = [{ uuid: 'a', updatedAt: '2026-09-04T00:00:00Z', data: '{}' }]

    const result = await syncPush('callum@example.com', 'tok', 'flight', rows)

    expect(result).toEqual({ upserted: ['a'], rejected: ['b'] })
    const [, init] = mock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'callum@example.com', token: 'tok', table: 'flight', rows })
  })
})
