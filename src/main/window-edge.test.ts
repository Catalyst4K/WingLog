import { describe, expect, it } from 'vitest'
import { edgeColour } from './window-edge'

describe('edgeColour', () => {
  it('is the page ground of the theme chosen', () => {
    expect(edgeColour('light', true)).toBe('#ebe8de')
    expect(edgeColour('dark', false)).toBe('#100f0e')
  })

  it('follows the system for "System"', () => {
    expect(edgeColour('system', true)).toBe('#100f0e')
    expect(edgeColour('system', false)).toBe('#ebe8de')
  })
})
