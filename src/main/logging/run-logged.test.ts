import { describe, expect, it, vi } from 'vitest'
import { logger } from './logger'
import { runLogged } from './run-logged'

describe('runLogged', () => {
  it('writes a failure to main.log and does not reject', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    runLogged('update check', Promise.reject(new Error('offline')))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[update check] failed: Error: offline'))
    warn.mockRestore()
  })

  it('stays quiet when the work succeeds', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    runLogged('update check', Promise.resolve(1))
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
