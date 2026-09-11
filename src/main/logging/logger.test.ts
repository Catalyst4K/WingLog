import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startCatching, functions, transports } = vi.hoisted(() => ({
  startCatching: vi.fn(),
  functions: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  transports: { file: { level: undefined as string | undefined }, console: { level: undefined as string | undefined } }
}))

vi.mock('electron-log/main', () => ({
  default: {
    transports,
    errorHandler: { startCatching },
    functions
  }
}))

describe('initLogger', () => {
  const originalConsole = { ...console }

  beforeEach(() => {
    vi.resetModules()
    transports.file.level = undefined
    transports.console.level = undefined
  })

  afterEach(() => {
    Object.assign(console, originalConsole)
  })

  it('sets file and console transport levels to info', async () => {
    const { initLogger } = await import('./logger')
    initLogger()
    expect(transports.file.level).toBe('info')
    expect(transports.console.level).toBe('info')
  })

  it('starts catching uncaught exceptions/rejections', async () => {
    const { initLogger } = await import('./logger')
    initLogger()
    expect(startCatching).toHaveBeenCalled()
  })

  it('replaces the global console with electron-log functions', async () => {
    const { initLogger } = await import('./logger')
    initLogger()
    expect(console.log).toBe(functions.log)
    expect(console.info).toBe(functions.info)
    expect(console.warn).toBe(functions.warn)
    expect(console.error).toBe(functions.error)
  })
})
