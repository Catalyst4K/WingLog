import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseQuestion } from './CloseQuestion'

describe('CloseQuestion', () => {
  let ready: boolean
  const send = vi.fn()
  const showWindow = vi.fn()
  const build = (): CloseQuestion => new CloseQuestion({ send, showWindow, isRendererReady: () => ready })

  beforeEach(() => {
    ready = true
    vi.clearAllMocks()
  })

  it('shows the window, asks the renderer, and resolves with its answer', async () => {
    const question = build()
    const asked = question.ask()
    expect(showWindow).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    question.answer(true)
    await expect(asked).resolves.toBe(true)

    const again = question.ask()
    question.answer(false)
    await expect(again).resolves.toBe(false)
  })

  it('closes without asking when the renderer is not there, so the app is never trapped open', async () => {
    ready = false
    await expect(build().ask()).resolves.toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(showWindow).not.toHaveBeenCalled()
  })

  it('takes an earlier unanswered question as keep open when a new one is asked', async () => {
    const question = build()
    const first = question.ask()
    const second = question.ask()
    await expect(first).resolves.toBe(false)
    question.answer(true)
    await expect(second).resolves.toBe(true)
  })

  it('ignores an answer when nothing was asked', () => {
    expect(() => build().answer(true)).not.toThrow()
  })
})
