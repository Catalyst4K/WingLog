import { describe, expect, it } from 'vitest'
import { atisRunway } from './atis-runway'

describe('atisRunway', () => {
  it.each([
    [['ATIS YPAD D 251012 [RWY] 23 +[WIND] 180/6 +[VIS] GT 10KM'], '23'],
    [['EGLL INFORMATION C. RUNWAY IN USE 27L. WIND 270/10'], '27L'],
    [['RUNWAY 09 IN USE'], '09'],
    [['ARRIVAL RWY 27R, DEPARTURE RWY 27R'], '27R'],
    [['expect visual approach runway 36c'], '36C'],
    [['LANDING AND DEPARTING RWY 05'], '05'],
    [['INFO A', 'RWY 18 IN USE', 'QNH 1013'], '18'],
    [['RUNWAYS IN USE 31'], '31'],
    [['RWY 30 LEFT OCCUPANCY REQUIRED'], '30L'],
    [['RUNWAY 09 CENTRE IN USE'], '09C']
  ])('names the one runway in %j', (lines, runway) => {
    expect(atisRunway(lines)).toBe(runway)
  })

  it.each([
    [['RWY 34L AND R FOR ARRS AND DEPS']],
    [['ARRIVAL RWY 27, DEPARTURE RWY 22']],
    [['RUNWAYS IN USE 27L, 27R']],
    [['RUNWAY 04L/22R']],
    [['RUNWAY 04L & 04R']],
    [['RWY 24R 24L SIMULTANEOUS PARALLEL OPERATION']],
    [['RWY 25C 18 ACDM IN PROGRESS']],
    [['TOWER CLOSED. REFER TO ERSA FOR RWY AVAILABILITY']],
    [['RUNWAY 27 CLOSED. RUNWAY 09 IN USE']],
    [['RWY 09 WIP']],
    [['SYCJ ATIS INFO A. 1000Z. VRB02KT 9000 FEW015']],
    [['RUNWAY 40 IN USE']],
    [['RUNWAY 00 IN USE']],
    [['RUNWAY WET']],
    [[]]
  ])('names none for %j', (lines) => {
    expect(atisRunway(lines)).toBeNull()
  })

  it('treats a runway named twice the same way as one runway, and a different second one as several', () => {
    expect(atisRunway(['ILS RWY 22L APPROACH', 'DEPARTING RWY 22L'])).toBe('22L')
    expect(atisRunway(['ILS RWY 22L APPROACH', 'DEPARTING RWY 22R'])).toBeNull()
  })

  it('returns only the matched runway, never the surrounding text', () => {
    expect(atisRunway(['<img src=x onerror=alert(1)> RWY 27 IN USE'])).toBe('27')
  })
})
