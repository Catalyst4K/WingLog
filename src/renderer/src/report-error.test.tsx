import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WingLogApi } from '@shared/ipc'
import { asyncHandler, reportError, runAsync } from './report-error'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  window.winglog = undefined as unknown as WingLogApi
})

describe('report-error', () => {
  it('sends a failure to main.log with what was being done', () => {
    const appLogRendererError = vi.fn().mockResolvedValue(undefined)
    window.winglog = { appLogRendererError } as unknown as WingLogApi
    reportError('settings: load theme', new Error('IPC closed'))
    reportError('fleet: lookup', 'plain string')
    expect(appLogRendererError).toHaveBeenNthCalledWith(1, 'settings: load theme', 'IPC closed')
    expect(appLogRendererError).toHaveBeenNthCalledWith(2, 'fleet: lookup', 'plain string')
  })

  it('never throws or rejects itself, even with no IPC or a failing log', async () => {
    expect(() => reportError('no ipc', new Error('x'))).not.toThrow()
    window.winglog = {
      appLogRendererError: vi.fn().mockRejectedValue(new Error('log failed'))
    } as unknown as WingLogApi
    reportError('failing log', new Error('x'))
    await settle()
  })

  it('reports a fire-and-forget promise that fails, and stays quiet when it succeeds', async () => {
    const appLogRendererError = vi.fn().mockResolvedValue(undefined)
    window.winglog = { appLogRendererError } as unknown as WingLogApi
    runAsync('ok', Promise.resolve(1))
    runAsync('settings: load units', Promise.reject(new Error('no db')))
    await settle()
    expect(appLogRendererError).toHaveBeenCalledOnce()
    expect(appLogRendererError).toHaveBeenCalledWith('settings: load units', 'no db')
  })

  it('wraps an async handler: same arguments in, nothing returned, a failure reported', async () => {
    const appLogRendererError = vi.fn().mockResolvedValue(undefined)
    window.winglog = { appLogRendererError } as unknown as WingLogApi
    const handler = vi.fn(async (id: number) => {
      if (id < 0) throw new Error('bad id')
    })
    const wrapped = asyncHandler('logbook: delete flight', handler)
    expect(wrapped(3)).toBeUndefined()
    wrapped(-1)
    await settle()
    expect(handler).toHaveBeenCalledWith(3)
    expect(appLogRendererError).toHaveBeenCalledWith('logbook: delete flight', 'bad id')
  })
})
