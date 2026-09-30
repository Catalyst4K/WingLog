import { describe, expect, it } from 'vitest'
import { latestAtcInstruction, parseAtcInstruction } from './beyondAtcInstruction'

// Every line below is real, verbatim ATC text from BeyondATC's Player.log (VHHH→KPHX and
// WSSS→ZSPD sessions, 2026-09-28/30) or flightdeck-backend's docs/beyondatc-notes.md.
function fieldsOf(text: string): Record<string, string> {
  return Object.fromEntries(parseAtcInstruction(text).fields.map((f) => [f.key, f.value]))
}

describe('parseAtcInstruction', () => {
  it('IFR clearance in flight levels', () => {
    const text =
      'Hongkong Shuttle 250, Hong Kong Delivery, information H current, cleared to Phoenix airport via PECA1D departure, runway 25C, climb via SID to FL140, squawk 6140.'
    expect(fieldsOf(text)).toEqual({
      station: 'Hong Kong Delivery',
      atis: 'H',
      clearedTo: 'Phoenix airport',
      sid: 'PECA1D',
      runway: '25C',
      climb: 'FL140',
      squawk: '6140'
    })
  })

  it('IFR clearance in feet', () => {
    const text =
      'Singapore 830 Super, Singapore Delivery, information I current, cleared to Pudong airport via VMR9F departure, runway 20R, climb via SID to 11000 feet, squawk 1151.'
    expect(fieldsOf(text)).toMatchObject({ sid: 'VMR9F', runway: '20R', climb: '11,000 ft', squawk: '1151' })
  })

  it('readback with a handoff', () => {
    const parsed = parseAtcInstruction('Hongkong Shuttle 250, readback correct. Contact ground 122.125 when ready for push or start.')
    expect(parsed.actions).toEqual(['readbackCorrect'])
    expect(parsed.fields).toEqual([{ key: 'contact', value: 'ground 122.125' }])
  })

  it('pushback approval with facing direction', () => {
    const parsed = parseAtcInstruction('Hongkong Shuttle 250, Hong Kong Ground, pushback and engine start approved. Face southwest.')
    expect(parsed.actions).toEqual(['pushback'])
    expect(parsed.fields).toEqual([
      { key: 'station', value: 'Hong Kong Ground' },
      { key: 'face', value: 'southwest' }
    ])
  })

  it('taxi clearance', () => {
    expect(fieldsOf('Hongkong Shuttle 250, taxi to holding point B10, runway 25C, via B8, B.')).toEqual({
      runway: '25C',
      holdingPoint: 'B10',
      taxiVia: 'B8, B'
    })
  })

  it('arrival taxi to a stand', () => {
    expect(fieldsOf('Test 830, taxi to Stand 73 via D1, D, P3, L02, W1, T4, W6, L08.')).toEqual({
      stand: '73',
      taxiVia: 'D1, D, P3, L02, W1, T4, W6, L08'
    })
  })

  it('tower handoff', () => {
    expect(fieldsOf('Hongkong Shuttle 250, contact Hong Kong Tower 118.2.')).toEqual({ contact: 'Hong Kong Tower 118.2' })
  })

  it('hold short, line up, and takeoff with wind', () => {
    expect(parseAtcInstruction('Hongkong Shuttle 250, hold short of runway 25C, departing traffic.').actions).toEqual(['holdShort'])
    expect(parseAtcInstruction('Hongkong Shuttle 250, runway 25C, lineup and wait.').actions).toEqual(['lineUp'])
    const takeoff = parseAtcInstruction('Hongkong Shuttle 250, Hong Kong Tower, wind 200 degrees, 7 knots, runway 25C, cleared for takeoff.')
    expect(takeoff.actions).toEqual(['takeoff'])
    expect(Object.fromEntries(takeoff.fields.map((f) => [f.key, f.value]))).toEqual({
      station: 'Hong Kong Tower',
      runway: '25C',
      wind: '200° 7 kt'
    })
  })

  it('squawk reset', () => {
    expect(fieldsOf('Hongkong Shuttle 250, reset transponder. Squawk 6140.')).toEqual({ squawk: '6140' })
  })

  it('radar identification with a climb', () => {
    const parsed = parseAtcInstruction('Hongkong Shuttle 250, Hong Kong Departure, identified, climb FL190.')
    expect(parsed.actions).toEqual(['identified'])
    expect(Object.fromEntries(parsed.fields.map((f) => [f.key, f.value]))).toEqual({ station: 'Hong Kong Departure', climb: 'FL190' })
  })

  it('metric descent with QNH', () => {
    expect(fieldsOf('Hongkong Shuttle 250, descend to 3,000m, QNH 1012.')).toEqual({ descend: '3,000 m', qnh: '1012' })
  })

  it('STAR clearance', () => {
    expect(fieldsOf('Hongkong Shuttle 250, cleared UPRS2C arrival, runway 08.')).toEqual({ star: 'UPRS2C', runway: '08' })
  })

  it('approach expectation with transition', () => {
    expect(
      fieldsOf('Singapore 830 Super, Shanghai Approach, QNH 1012 expect the ILS-Z approach runway 17R with the PD201 transition.')
    ).toMatchObject({ approach: 'ILS Z 17R', transition: 'PD201', runway: '17R', qnh: '1012' })
  })

  it('approach clearance with a direct', () => {
    expect(
      fieldsOf('Singapore 830 Super, cleared direct PD201, cross PD201 at or above 3000 feet, cleared ILS-Z approach runway 17R.')
    ).toMatchObject({ approach: 'ILS Z 17R', runway: '17R', direct: 'PD201' })
  })

  it('an unrecognised instruction yields no fields rather than guessing', () => {
    expect(parseAtcInstruction('Hongkong Shuttle 250, report ready for descent.')).toEqual({ actions: [], fields: [] })
  })
})

describe('latestAtcInstruction', () => {
  it("picks the most recent ATC line, ignoring the pilot's own and other traffic", () => {
    const latest = latestAtcInstruction([
      { speaker: 'atc', text: 'Hongkong Shuttle 250, contact Hong Kong Tower 118.2.', ts: 1 },
      { speaker: 'player', text: 'Contact Hong Kong Tower 118.2, Hongkong Shuttle 250.', ts: 2 },
      { speaker: 'atcTraffic', text: 'Other 1, cleared for takeoff.', ts: 3 }
    ])
    expect(latest).toMatchObject({ ts: 1, fields: [{ key: 'contact', value: 'Hong Kong Tower 118.2' }] })
  })

  it('is null before ATC has said anything', () => {
    expect(latestAtcInstruction([{ speaker: 'player', text: 'Radio check.', ts: 1 }])).toBeNull()
  })
})
