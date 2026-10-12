import { describe, expect, it } from 'vitest'
import { chooseDisplay, windowShow, type DisplayBounds } from './e2e-window'

const MAIN: DisplayBounds = { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, primary: true }
const SECOND: DisplayBounds = { bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, primary: false }

describe('windowShow', () => {
  it('knows hidden and inactive, and shows normally for anything else', () => {
    expect(windowShow('hidden')).toBe('hidden')
    expect(windowShow('inactive')).toBe('inactive')
    for (const other of [undefined, '', 'visible', 'INACTIVE']) expect(windowShow(other)).toBe('normal')
  })
})

describe('chooseDisplay', () => {
  it('takes the display asked for, counting from 1', () => {
    expect(chooseDisplay([MAIN, SECOND], '1')).toBe(MAIN)
    expect(chooseDisplay([MAIN, SECOND], '2')).toBe(SECOND)
  })

  it('takes the first non-primary display when none is asked for, or the one asked for does not exist', () => {
    expect(chooseDisplay([MAIN, SECOND], undefined)).toBe(SECOND)
    expect(chooseDisplay([MAIN, SECOND], '3')).toBe(SECOND)
    expect(chooseDisplay([MAIN, SECOND], 'x')).toBe(SECOND)
  })

  it('leaves the window where it is with only one display', () => {
    expect(chooseDisplay([MAIN], undefined)).toBeNull()
    expect(chooseDisplay([], undefined)).toBeNull()
  })
})
