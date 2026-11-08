import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  deleteAccount,
  forgotPassword,
  resetPassword,
  login,
  logout,
  provision,
  syncPullPage,
  syncPush
} from './sync-client'

function fetchMock(status: number, body: unknown) {
  return vi.fn<
    (
      url: string,
      init?: RequestInit
    ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
  >(async () => ({ ok: status < 400, status, json: async () => body }))
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
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'callum@example.com',
      password: 'hunter22222222'
    })
  })

  it('surfaces the same message on wrong password or unknown account', async () => {
    vi.stubGlobal('fetch', fetchMock(401, { error: 'invalid email or password' }))
    await expect(login('callum@example.com', 'wrong')).rejects.toThrow('invalid email or password')
  })
})

describe('provision', () => {
  it('posts email/password and sends the invite code as X-Provision-Secret', async () => {
    const mock = fetchMock(200, { ok: true })
    vi.stubGlobal('fetch', mock)

    await provision('newuser@example.com', 'hunter22222222', 'the-invite-code')

    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('https://flightdeck-backend.callum-jones5.workers.dev/auth/provision')
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'newuser@example.com',
      password: 'hunter22222222'
    })
    expect((init?.headers as Record<string, string>)['X-Provision-Secret']).toBe('the-invite-code')
  })

  it('surfaces a wrong invite code as the same not-found error the route gives anyone else', async () => {
    vi.stubGlobal('fetch', fetchMock(404, { error: 'not found' }))
    await expect(provision('newuser@example.com', 'hunter22222222', 'wrong-code')).rejects.toThrow(
      'not found'
    )
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

describe('forgotPassword and resetPassword', () => {
  it('post the address, and the address, code and new password', async () => {
    const mock = fetchMock(200, { ok: true })
    vi.stubGlobal('fetch', mock)
    await forgotPassword('callum@example.com')
    await resetPassword('callum@example.com', 'ABCD2345', 'a brand new password')
    const [forgotUrl, forgotInit] = mock.mock.calls[0]
    expect(forgotUrl).toBe('https://flightdeck-backend.callum-jones5.workers.dev/auth/forgot')
    expect(JSON.parse(forgotInit?.body as string)).toEqual({ email: 'callum@example.com' })
    const [resetUrl, resetInit] = mock.mock.calls[1]
    expect(resetUrl).toBe('https://flightdeck-backend.callum-jones5.workers.dev/auth/reset')
    expect(JSON.parse(resetInit?.body as string)).toEqual({
      email: 'callum@example.com',
      code: 'ABCD2345',
      password: 'a brand new password'
    })
  })

  it('fail with the service’s own message', async () => {
    vi.stubGlobal('fetch', fetchMock(401, { error: 'invalid or expired code' }))
    await expect(resetPassword('callum@example.com', 'WRONG234', 'a brand new password')).rejects.toThrow(
      'invalid or expired code'
    )
  })
})

describe('deleteAccount', () => {
  it('posts email and password to /auth/delete, and fails when the backend refuses', async () => {
    const mock = fetchMock(200, { ok: true })
    vi.stubGlobal('fetch', mock)
    await deleteAccount('callum@example.com', 'a long enough password')
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('https://flightdeck-backend.callum-jones5.workers.dev/auth/delete')
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'callum@example.com',
      password: 'a long enough password'
    })
    vi.stubGlobal('fetch', fetchMock(401, { error: 'invalid email or password' }))
    await expect(deleteAccount('callum@example.com', 'wrong')).rejects.toThrow()
  })
})

describe('syncPullPage', () => {
  const row = { uuid: 'a', updatedAt: '2026-09-04T00:00:00.000Z', data: '{}' }

  it('asks for the page after the cursor and returns the rows, the next cursor and whether there is more', async () => {
    const mock = fetchMock(200, { rows: [row], cursor: 7, more: true })
    vi.stubGlobal('fetch', mock)

    const page = await syncPullPage('callum@example.com', 'tok', 'aircraft', 3)

    expect(page).toEqual({ rows: [row], cursor: 7, more: true })
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('https://flightdeck-backend.callum-jones5.workers.dev/sync/pull')
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'callum@example.com',
      token: 'tok',
      table: 'aircraft',
      cursor: 3
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('asks for everything with a null cursor', async () => {
    const mock = fetchMock(200, { rows: [], cursor: 0, more: false })
    vi.stubGlobal('fetch', mock)
    await syncPullPage('callum@example.com', 'tok', 'flight', null)
    expect(JSON.parse(mock.mock.calls[0][1]?.body as string).cursor).toBeNull()
  })

  it('surfaces a 401 as a thrown error, distinguishable from a network failure', async () => {
    vi.stubGlobal('fetch', fetchMock(401, { error: 'invalid or expired session' }))
    await expect(syncPullPage('callum@example.com', 'tok', 'aircraft', null)).rejects.toThrow(
      'invalid or expired session'
    )
  })

  it.each([
    ['rows that are not rows', { rows: [{ uuid: 'a' }], cursor: 1, more: false }],
    ['rows that are not a list', { rows: 'x', cursor: 1, more: false }],
    ['a null row', { rows: [null], cursor: 1, more: false }],
    ['a cursor that is not a whole number', { rows: [], cursor: 1.5, more: false }],
    ['a negative cursor', { rows: [], cursor: -1, more: false }],
    ['a missing cursor', { rows: [], more: false }],
    ['a more that is not true or false', { rows: [], cursor: 1, more: 'yes' }]
  ])('refuses an answer with %s', async (_name, body) => {
    vi.stubGlobal('fetch', fetchMock(200, body))
    await expect(syncPullPage('callum@example.com', 'tok', 'aircraft', null)).rejects.toThrow(
      'The backend answered with something unexpected.'
    )
  })
})

describe('syncPush', () => {
  it('posts the table and rows, returns upserted, rejected and refused', async () => {
    const mock = fetchMock(200, { upserted: ['a'], rejected: ['b'], refused: ['c'] })
    vi.stubGlobal('fetch', mock)
    const rows = [{ uuid: 'a', updatedAt: '2026-09-04T00:00:00Z', data: '{}' }]

    const result = await syncPush('callum@example.com', 'tok', 'flight', rows)

    expect(result).toEqual({ upserted: ['a'], rejected: ['b'], refused: ['c'] })
    const [, init] = mock.mock.calls[0]
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'callum@example.com',
      token: 'tok',
      table: 'flight',
      rows
    })
  })

  it('takes an older Worker’s answer, which has no refused list, as none refused', async () => {
    vi.stubGlobal('fetch', fetchMock(200, { upserted: ['a'], rejected: [] }))
    const result = await syncPush('callum@example.com', 'tok', 'flight', [])
    expect(result).toEqual({ upserted: ['a'], rejected: [], refused: [] })
  })

  it.each([
    ['upserted that is not a list of text', { upserted: [1], rejected: [], refused: [] }],
    ['rejected that is missing', { upserted: [], refused: [] }],
    ['refused that is not a list', { upserted: [], rejected: [], refused: 'x' }]
  ])('refuses an answer with %s', async (_name, body) => {
    vi.stubGlobal('fetch', fetchMock(200, body))
    await expect(syncPush('callum@example.com', 'tok', 'flight', [])).rejects.toThrow(
      'The backend answered with something unexpected.'
    )
  })

  it('gives each sync call a time limit, so a stalled connection cannot hold a sync open for ever', async () => {
    const limit = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', fetchMock(200, { upserted: [], rejected: [] }))
    await syncPush('callum@example.com', 'tok', 'flight', [])
    vi.stubGlobal('fetch', fetchMock(200, { rows: [], cursor: 0, more: false }))
    await syncPullPage('callum@example.com', 'tok', 'flight', null)
    vi.stubGlobal('fetch', fetchMock(200, { token: 't', expiresAt: 'x' }))
    await login('callum@example.com', 'a password')
    expect(limit.mock.calls.map(([ms]) => ms)).toEqual([120_000, 120_000, 30_000])
    limit.mockRestore()
  })
  it('says the status when an error answer is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, json: async () => Promise.reject(new Error('not json')) }))
    )
    await expect(syncPush('callum@example.com', 'tok', 'flight', [])).rejects.toThrow(
      'Request to /sync/push failed (502)'
    )
  })
})
