import { describe, expect, it, vi } from 'vitest'
import { localWriteHappened, onLocalWrite } from './local-write-hints'

describe('local write hints', () => {
  it('tells every listener a write happened, until it stops listening', () => {
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = onLocalWrite(first)
    const stopSecond = onLocalWrite(second)

    localWriteHappened()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    stopFirst()
    localWriteHappened()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    stopSecond()
  })

  it('does not let a listener that fails stop the others, or the write that told them', () => {
    const after = vi.fn()
    const stopBroken = onLocalWrite(() => {
      throw new Error('listener bug')
    })
    const stopAfter = onLocalWrite(after)

    expect(() => localWriteHappened()).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    stopBroken()
    stopAfter()
  })
})
