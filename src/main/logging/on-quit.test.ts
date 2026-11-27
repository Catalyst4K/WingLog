import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { logger } from './logger'
import { onQuit } from './on-quit'

describe('onQuit', () => {
  it('runs every step in order even when one throws or rejects, and logs each failure by name', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const app = new EventEmitter()
    const ran: string[] = []
    onQuit(app, 'first', () => ran.push('first'))
    onQuit(app, 'second', () => {
      ran.push('second')
      throw new Error('boom')
    })
    onQuit(app, 'third', () => {
      ran.push('third')
      return Promise.reject(new Error('later'))
    })
    onQuit(app, 'fourth', () => ran.push('fourth'))

    expect(() => app.emit('before-quit')).not.toThrow()

    expect(ran).toEqual(['first', 'second', 'third', 'fourth'])
    expect(warn).toHaveBeenCalledWith('[quit: second] failed: Error: boom')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[quit: third] failed: Error: later'))
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
