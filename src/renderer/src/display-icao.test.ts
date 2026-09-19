import { describe, expect, it } from 'vitest'
import { displayIcao } from './display-icao'

describe('displayIcao', () => {
  it('renders the ZZZZ placeholder as Unknown', () => {
    expect(displayIcao('ZZZZ')).toBe('Unknown')
  })

  it('passes a real ICAO code through unchanged', () => {
    expect(displayIcao('EGLL')).toBe('EGLL')
  })
})
