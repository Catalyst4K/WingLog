import { describe, expect, it } from 'vitest'
import { greatCircleM, initialBearingDeg } from '../geo'
import { clearsHoldShort, holdShortBarEnds } from './hold-short-bar'

const atc = (text: string, ts = 2_000) => ({ speaker: 'atc' as const, text, ts })

describe('clearsHoldShort', () => {
  it.each([
    'Speedbird 33 Heavy, runway 20C, line up and wait.',
    'Speedbird 33 Heavy, wind 200 at 8, runway 20C, cleared for takeoff.',
    'Speedbird 33 Heavy, Line up and wait runway two zero centre'
  ])('clears the bar for a line that lines us up or clears us to take off: %s', (text) => {
    expect(clearsHoldShort(atc(text), '20C', 1_000)).toBe(true)
  })

  it('clears for a line that names no runway at all', () => {
    expect(clearsHoldShort(atc('Speedbird 33 Heavy, cleared for take-off.'), '20C', 1_000)).toBe(true)
  })

  it('does not clear for another runway’s clearance, or for a different instruction', () => {
    expect(clearsHoldShort(atc('Runway 02, line up and wait.'), '20C', 1_000)).toBe(false)
    expect(clearsHoldShort(atc('Speedbird 33 Heavy, hold short of runway 20C.'), '20C', 1_000)).toBe(false)
    expect(clearsHoldShort(atc('Speedbird 33 Heavy, taxi to holding point A via D.'), null, 1_000)).toBe(
      false
    )
  })

  it('reads a runway number with a leading zero or one digit the same way', () => {
    expect(clearsHoldShort(atc('Runway 8, cleared for takeoff.'), '08', 1_000)).toBe(true)
    expect(clearsHoldShort(atc('Runway 08, line up and wait.'), '8', 1_000)).toBe(true)
    expect(clearsHoldShort(atc('Runway 27, line up and wait.'), '08', 1_000)).toBe(false)
  })

  it('only counts what ATC said to us, after the bar appeared', () => {
    const line = 'Runway 20C, line up and wait.'
    expect(clearsHoldShort({ speaker: 'traffic', text: line, ts: 2_000 }, '20C', 1_000)).toBe(false)
    expect(clearsHoldShort({ speaker: 'atcTraffic', text: line, ts: 2_000 }, '20C', 1_000)).toBe(false)
    expect(clearsHoldShort({ speaker: 'player', text: line, ts: 2_000 }, '20C', 1_000)).toBe(false)
    expect(clearsHoldShort(atc(line, 999), '20C', 1_000)).toBe(false)
  })

  it('clears a holding point (no runway) on any line-up or takeoff clearance', () => {
    expect(clearsHoldShort(atc('Runway 27R, line up and wait.'), null, 1_000)).toBe(true)
  })
})

describe('holdShortBarEnds', () => {
  const line: [number, number][] = [
    [0.0, 51.0],
    [0.001, 51.0],
    [0.002, 51.0]
  ]

  it('is a bar across the end of the line, square to the way the line points, centred on its end', () => {
    const ends = holdShortBarEnds(line)!
    const [a, b] = ends
    const mid = { lat: (a[1] + b[1]) / 2, lon: (a[0] + b[0]) / 2 }
    expect(greatCircleM(mid, { lat: 51.0, lon: 0.002 })).toBeLessThan(0.5)
    expect(greatCircleM({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] })).toBeCloseTo(24, 0)
    // The line runs due east, so the bar runs north to south.
    const across = initialBearingDeg({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] })
    expect(Math.min(across, 360 - across, Math.abs(across - 180))).toBeLessThan(0.5)
  })

  it('skips repeated points at the end to find which way the line points', () => {
    const repeated: [number, number][] = [...line, [0.002, 51.0], [0.002, 51.0]]
    expect(holdShortBarEnds(repeated)).toEqual(holdShortBarEnds(line))
  })

  it('has no bar for a line that is one point or none', () => {
    expect(holdShortBarEnds([])).toBeNull()
    expect(holdShortBarEnds([[0, 51]])).toBeNull()
    expect(
      holdShortBarEnds([
        [0, 51],
        [0, 51]
      ])
    ).toBeNull()
  })
})
