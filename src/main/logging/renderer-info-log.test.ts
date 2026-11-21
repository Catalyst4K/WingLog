import { describe, expect, it } from 'vitest'
import { RENDERER_INFO_MAX_LINES, RENDERER_INFO_WINDOW_MS, RendererInfoLog } from './renderer-info-log'

describe('RendererInfoLog', () => {
  function make(): { log: RendererInfoLog; lines: string[]; at: { ms: number } } {
    const lines: string[] = []
    const at = { ms: 1_000_000 }
    return {
      log: new RendererInfoLog(
        (line) => lines.push(line),
        () => at.ms
      ),
      lines,
      at
    }
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

  it('says nothing about drops when none happened', () => {
    const { log, lines, at } = make()
    log.write('atc-prompt', 'a')
    at.ms += RENDERER_INFO_WINDOW_MS * 3
    log.write('atc-prompt', 'b')
    expect(lines).toEqual(['[atc-prompt] a', '[atc-prompt] b'])
  })
})
