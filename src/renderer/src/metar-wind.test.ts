import { describe, expect, it } from 'vitest'
import { formatWind, parseWindGroup } from './metar-wind'

describe('parseWindGroup', () => {
  it('parses a standard KT wind group', () => {
    // Real EGLL METAR (MetarReport.rawText doc comment in ipc.ts).
    expect(parseWindGroup('METAR EGLL 012320Z AUTO 25008KT 9999 NCD 18/12 Q1020')).toEqual({
      directionDeg: 250,
      isVariable: false,
      speedValue: 8,
      gustValue: null,
      sourceUnit: 'kt'
    })
  })

  it('parses an MPS wind group (common outside North America)', () => {
    expect(parseWindGroup('METAR UUEE 012320Z 31015MPS 9999 FEW030 05/M02 Q1015')).toEqual({
      directionDeg: 310,
      isVariable: false,
      speedValue: 15,
      gustValue: null,
      sourceUnit: 'mps'
    })
  })

  it('parses a gust group', () => {
    expect(parseWindGroup('METAR KJFK 012351Z 28015G25KT 10SM FEW250 22/12 A3002')).toEqual({
      directionDeg: 280,
      isVariable: false,
      speedValue: 15,
      gustValue: 25,
      sourceUnit: 'kt'
    })
  })

  it('parses a variable direction', () => {
    expect(parseWindGroup('METAR KLAX 012351Z VRB03KT 10SM CLR 20/10 A3005')).toEqual({
      directionDeg: null,
      isVariable: true,
      speedValue: 3,
      gustValue: null,
      sourceUnit: 'kt'
    })
  })

  it('returns null when there is no recognisable wind group', () => {
    expect(parseWindGroup('METAR ZZZZ 012351Z NIL')).toBeNull()
  })
})

describe('formatWind', () => {
  const kt = { directionDeg: 250, isVariable: false, speedValue: 8, gustValue: null, sourceUnit: 'kt' as const }

  it('shows the value verbatim when the display unit matches the source unit', () => {
    expect(formatWind(kt, 'kt')).toBe('Wind 250° at 8 kt')
  })

  it('converts kt to m/s for display', () => {
    // 8 kt * 0.514444 = 4.1... -> rounds to 4
    expect(formatWind(kt, 'mps')).toBe('Wind 250° at 4 m/s')
  })

  it('converts mps to kt for display', () => {
    const mps = { directionDeg: 310, isVariable: false, speedValue: 15, gustValue: null, sourceUnit: 'mps' as const }
    // 15 mps / 0.514444 = 29.15... -> rounds to 29
    expect(formatWind(mps, 'kt')).toBe('Wind 310° at 29 kt')
  })

  it('never round-trips a same-unit value through a conversion (no rounding drift)', () => {
    const mps = { directionDeg: 100, isVariable: false, speedValue: 7, gustValue: null, sourceUnit: 'mps' as const }
    expect(formatWind(mps, 'mps')).toBe('Wind 100° at 7 m/s')
  })

  it('formats a gust', () => {
    const gust = { directionDeg: 280, isVariable: false, speedValue: 15, gustValue: 25, sourceUnit: 'kt' as const }
    expect(formatWind(gust, 'kt')).toBe('Wind 280° at 15 kt, gusting 25 kt')
  })

  it('formats a variable direction', () => {
    const variable = { directionDeg: null, isVariable: true, speedValue: 3, gustValue: null, sourceUnit: 'kt' as const }
    expect(formatWind(variable, 'kt')).toBe('Wind Variable at 3 kt')
  })
})
