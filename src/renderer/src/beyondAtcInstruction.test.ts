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

  it('taxi clearance with a Heathrow link taxiway (EGLL, 2026-10-05)', () => {
    expect(fieldsOf('Koreanair 443 Heavy, taxi via E, LINK 36, F, A, R, hold short of runway 27L.').taxiVia).toBe('E, LINK 36, F, A, R')
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

  // Real YBBN lines, 2026-10-02: the readback used to replace the clearance on the card.
  const CLEARANCE = 'Cathay 168 Heavy, Brisbane Delivery, information A current, cleared to Hong Kong airport via the BIXAD2 departure, runway 01R, climb via SID to 10000 feet, squawk 6022.'
  const READBACK = 'Cathay 168 Heavy, readback correct. Contact ground 122.25 when ready for pushback or engine start.'

  it('keeps the clearance up after "readback correct", adding only the frequency it hands over', () => {
    const latest = latestAtcInstruction([
      { speaker: 'atc', text: CLEARANCE, ts: 1 },
      { speaker: 'player', text: 'Cleared to Hong Kong airport via the BIXAD2 departure…', ts: 2 },
      { speaker: 'atc', text: READBACK, ts: 3 }
    ])
    expect(latest?.actions).toEqual([])
    expect(latest?.fields).toEqual([
      { key: 'station', value: 'Brisbane Delivery' },
      { key: 'atis', value: 'A' },
      { key: 'clearedTo', value: 'Hong Kong airport' },
      { key: 'sid', value: 'BIXAD2' },
      { key: 'runway', value: '01R' },
      { key: 'climb', value: '10,000 ft' },
      { key: 'squawk', value: '6022' },
      { key: 'contact', value: 'ground 122.25' }
    ])
    expect(latest?.text).toBe(`${CLEARANCE} ${READBACK}`)
    expect(latest?.ts).toBe(3)
  })

  it('replaces the clearance once ATC says something new', () => {
    const latest = latestAtcInstruction([
      { speaker: 'atc', text: CLEARANCE, ts: 1 },
      { speaker: 'atc', text: READBACK, ts: 3 },
      { speaker: 'atc', text: 'Cathay 168 Heavy, pushback and engine start approved, face south.', ts: 5 }
    ])
    expect(latest?.actions).toEqual(['pushback'])
    expect(latest?.fields.find((f) => f.key === 'sid')).toBeUndefined()
  })

  it('shows a readback on its own when there is nothing before it to confirm', () => {
    expect(latestAtcInstruction([{ speaker: 'atc', text: READBACK, ts: 3 }])?.actions).toEqual(['readbackCorrect'])
  })

  it('is null before ATC has said anything', () => {
    expect(latestAtcInstruction([{ speaker: 'player', text: 'Radio check.', ts: 1 }])).toBeNull()
  })
})
