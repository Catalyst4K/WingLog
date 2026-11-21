import { describe, expect, it } from 'vitest'
import { RENDERER_INFO_MAX_LINES, RENDERER_INFO_WINDOW_MS, RendererInfoLog } from './renderer-info-log'

describe('RendererInfoLog', () => {
  function make(): {
    log: RendererInfoLog
    lines: string[]
    at: { ms: number }
    timers: (() => void)[]
  } {
    const lines: string[] = []
    const timers: (() => void)[] = []
    const at = { ms: 1_000_000 }
    const log = new RendererInfoLog(
      (line) => lines.push(line),
      () => at.ms,
      (run) => timers.push(run)
    )
    return { log, lines, at, timers }
  }

  it('writes a line under a known tag', () => {
    const { log, lines } = make()
    log.write('atc-prompt', 'offered "STAR UPRS2C, runway 08"')
    expect(lines).toEqual(['[atc-prompt] offered "STAR UPRS2C, runway 08"'])
  })

  it('ignores a tag it does not know, or one that is not a string, so a screen cannot forge another log prefix', () => {
    const { log, lines } = make()
    log.write('beyondatc', 'InfoBoxes []')
    log.write(['atc-prompt'], 'x')
    log.write(undefined, 'x')
    expect(lines).toEqual([])
  })

  it('stops at the cap within a window, then says how many it dropped when the next window opens', () => {
    const { log, lines, at } = make()
    for (let i = 0; i < RENDERER_INFO_MAX_LINES + 5; i++) log.write('atc-prompt', `line ${i}`)
    expect(lines).toHaveLength(RENDERER_INFO_MAX_LINES)
    at.ms += RENDERER_INFO_WINDOW_MS
    log.write('atc-prompt', 'later')
    expect(lines.slice(-2)).toEqual(['[atc-prompt] 5 lines dropped: too many in 10 s', '[atc-prompt] later'])
  })

  it('says how many it dropped when the window ends, even if no later line comes', () => {
    const { log, lines, timers } = make()
    for (let i = 0; i < RENDERER_INFO_MAX_LINES + 3; i++) log.write('atc-prompt', `line ${i}`)
    expect(timers).toHaveLength(1)
    timers[0]?.()
    expect(lines.at(-1)).toBe('[atc-prompt] 3 lines dropped: too many in 10 s')
    timers[0]?.() // running it again says nothing more
    expect(lines.filter((line) => line.includes('dropped'))).toHaveLength(1)
  })

  it('opens a new window when the clock steps back, so the cap does not hold for as long as the step', () => {
    const { log, lines, at } = make()
    for (let i = 0; i < RENDERER_INFO_MAX_LINES; i++) log.write('atc-prompt', `line ${i}`)
    at.ms -= 60_000
    log.write('atc-prompt', 'after the step')
    expect(lines.at(-1)).toBe('[atc-prompt] after the step')
  })

  it('says nothing about drops when none happened', () => {
    const { log, lines, at } = make()
    log.write('atc-prompt', 'a')
    at.ms += RENDERER_INFO_WINDOW_MS * 3
    log.write('atc-prompt', 'b')
    expect(lines).toEqual(['[atc-prompt] a', '[atc-prompt] b'])
  })
})
