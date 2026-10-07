import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WingLogApi } from '@shared/ipc'
import { winglogApi } from './winglog-api'

describe('winglogApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns whatever window.winglog is at the time of the call', () => {
    const first = { appGetVersion: vi.fn() } as unknown as WingLogApi
    const second = { appGetVersion: vi.fn() } as unknown as WingLogApi
    vi.stubGlobal('window', { winglog: first })
    expect(winglogApi()).toBe(first)
    vi.stubGlobal('window', { winglog: second })
    expect(winglogApi()).toBe(second)
  })
})
