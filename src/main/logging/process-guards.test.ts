import { describe, expect, it, vi } from 'vitest'
import { installProcessGuards } from './process-guards'

describe('installProcessGuards', () => {
  it('logs an uncaught exception and an unhandled rejection instead of leaving them to the error dialog', () => {
    const handlers: Record<string, (value: never) => void> = {}
    const target = {
      on: (event: string, listener: (value: never) => void) => {
        handlers[event] = listener
        return target
      }
    }
    const log = vi.fn()
    installProcessGuards(target as never, log)

    const error = new Error('SqliteError: database or disk is full')
    handlers.uncaughtException(error as never)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('uncaught exception: Error: SqliteError: database or disk is full')
    )

    handlers.unhandledRejection('plain reason' as never)
    expect(log).toHaveBeenLastCalledWith('[main] unhandled rejection: plain reason')
  })
})
