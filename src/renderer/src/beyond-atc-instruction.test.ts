import { describe, expect, it } from 'vitest'
import { instructionFromBoxes, latestAtcInstruction, parseAtcInstruction } from './beyond-atc-instruction'

// Every line below is real, verbatim ATC text from BeyondATC's Player.log (VHHH→KPHX and
// WSSS→ZSPD sessions, 2026-09-28/30) or winglog-backend's docs/beyondatc-notes.md.
function fieldsOf(text: string): Record<string, string> {
  return Object.fromEntries(parseAtcInstruction(text).fields.map((f) => [f.key, f.value]))
}

const NO_BOXES = { infoBoxes: [], infoBoxesAt: null }

describe('parseAtcInstruction: only the facts with no InfoBox', () => {
  it('reads the station and cleared-to airport from a clearance, and nothing a box carries', () => {
    const text =
      'Hongkong Shuttle 250, Hong Kong Delivery, information H current, cleared to Phoenix airport via PECA1D departure, runway 25C, climb via SID to FL140, squawk 6140.'
    expect(fieldsOf(text)).toEqual({ station: 'Hong Kong Delivery', clearedTo: 'Phoenix airport' })
  })

  it('reads cleared-to in every real wording', () => {
    expect(
      fieldsOf(
        'Cathay 168 Heavy, Brisbane Delivery, cleared to Hong Kong airport via the BIXAD2 departure, runway 01R.'
      ).clearedTo
    ).toBe('Hong Kong airport')
    expect(
      fieldsOf('Test 830, Test Delivery, cleared to Pudong via VMR9B departure, runway 20C.').clearedTo
    ).toBe('Pudong')
  })

  it('reads wind and the labels: hold short, line up, readback, identified', () => {
    expect(
      parseAtcInstruction('Hongkong Shuttle 250, hold short of runway 25C, departing traffic.').actions
    ).toEqual(['holdShort'])
    expect(parseAtcInstruction('Hongkong Shuttle 250, runway 25C, lineup and wait.').actions).toEqual([
      'lineUp'
    ])
    expect(
      parseAtcInstruction(
        'Hongkong Shuttle 250, readback correct. Contact ground 122.125 when ready for push or start.'
      )
    ).toEqual({
      actions: ['readbackCorrect'],
      fields: []
    })
    const identified = parseAtcInstruction(
      'Hongkong Shuttle 250, Hong Kong Departure, identified, climb FL190.'
    )
    expect(identified.actions).toEqual(['identified'])
    expect(identified.fields).toEqual([{ key: 'station', value: 'Hong Kong Departure' }])
    const takeoff = parseAtcInstruction(
      'Hongkong Shuttle 250, Hong Kong Tower, wind 200 degrees, 7 knots, runway 25C, cleared for takeoff.'
    )
    // Takeoff itself and the runway come from the `Cleared for Takeoff` box.
    expect(takeoff).toEqual({
      actions: [],
      fields: [
        { key: 'station', value: 'Hong Kong Tower' },
        { key: 'wind', value: '200° 7 kt' }
      ]
    })
  })

  it('reads a direct', () => {
    expect(
      fieldsOf(
        'Singapore 830 Super, cleared direct PD201, cross PD201 at or above 3000 feet, cleared ILS-Z approach runway 17R.'
      )
    ).toEqual({
      direct: 'PD201'
    })
  })

  it('reads nothing from a line whose facts all have boxes', () => {
    expect(parseAtcInstruction('Hongkong Shuttle 250, descend to 3,000m, QNH 1012.')).toEqual({
      actions: [],
      fields: []
    })
    expect(
      parseAtcInstruction('Hongkong Shuttle 250, taxi to holding point B10, runway 25C, via B8, B.')
    ).toEqual({ actions: [], fields: [] })
    expect(parseAtcInstruction('Hongkong Shuttle 250, report ready for descent.')).toEqual({
      actions: [],
      fields: []
    })
  })
})

describe('latestAtcInstruction', () => {
  it("picks the most recent ATC line, ignoring the pilot's own and other traffic", () => {
    const latest = latestAtcInstruction(
      [
        {
          speaker: 'atc',
          text: 'Hongkong Shuttle 250, Hong Kong Tower, wind 200 degrees, 7 knots, runway 25C, cleared for takeoff.',
          ts: 1
        },
        { speaker: 'player', text: 'Cleared for takeoff, Hongkong Shuttle 250.', ts: 2 },
        { speaker: 'atcTraffic', text: 'Other 1, Hong Kong Tower, cleared for takeoff.', ts: 3 }
      ],
      NO_BOXES
    )
    expect(latest).toMatchObject({
      ts: 1,
      fields: [
        { key: 'station', value: 'Hong Kong Tower' },
        { key: 'wind', value: '200° 7 kt' }
      ]
    })
  })

  // Real YBBN lines, 2026-10-02: the readback used to replace the clearance on the card.
  const CLEARANCE =
    'Cathay 168 Heavy, Brisbane Delivery, information A current, cleared to Hong Kong airport via the BIXAD2 departure, runway 01R, climb via SID to 10000 feet, squawk 6022.'
  const READBACK =
    'Cathay 168 Heavy, readback correct. Contact ground 122.25 when ready for pushback or engine start.'

  it('keeps the clearance up after "readback correct", with the boxes that came with it', () => {
    const latest = latestAtcInstruction(
      [
        { speaker: 'atc', text: CLEARANCE, ts: 1000 },
        { speaker: 'player', text: 'Cleared to Hong Kong airport via the BIXAD2 departure…', ts: 2000 },
        { speaker: 'atc', text: READBACK, ts: 3000 }
      ],
      {
        infoBoxes: [
          { title: 'Taxi to Runway', info: '01R' },
          { title: 'SID', info: 'BIXAD2' },
          { title: 'Ground Frequency', info: '122.25' }
        ],
        infoBoxesAt: 3200
      }
    )
    expect(latest?.actions).toEqual([])
    expect(latest?.fields).toEqual([
      { key: 'station', value: 'Brisbane Delivery' },
      { key: 'clearedTo', value: 'Hong Kong airport' },
      { key: 'runway', value: '01R' },
      { key: 'sid', value: 'BIXAD2' },
      { key: 'contact', value: 'Ground 122.25' }
    ])
    expect(latest?.text).toBe(`${CLEARANCE} ${READBACK}`)
    expect(latest?.ts).toBe(3000)
  })

  it('replaces the clearance once ATC says something new', () => {
    const latest = latestAtcInstruction(
      [
        { speaker: 'atc', text: CLEARANCE, ts: 1000 },
        { speaker: 'atc', text: READBACK, ts: 3000 },
        {
          speaker: 'atc',
          text: 'Cathay 168 Heavy, Brisbane Ground, pushback and engine start approved, face south.',
          ts: 60_000
        }
      ],
      { infoBoxes: [{ title: 'Pushback Direction', info: 'south' }], infoBoxesAt: 60_100 }
    )
    expect(latest?.actions).toEqual(['pushback'])
    expect(latest?.fields).toEqual([
      { key: 'station', value: 'Brisbane Ground' },
      { key: 'face', value: 'south' }
    ])
  })

  it('shows a readback on its own when there is nothing before it to confirm', () => {
    expect(latestAtcInstruction([{ speaker: 'atc', text: READBACK, ts: 3 }], NO_BOXES)?.actions).toEqual([
      'readbackCorrect'
    ])
  })

  it('is null before ATC has said anything', () => {
    expect(latestAtcInstruction([{ speaker: 'player', text: 'Radio check.', ts: 1 }], NO_BOXES)).toBeNull()
  })

  it("doesn't show an older box set with a later line that has none (exit left at A7)", () => {
    const result = latestAtcInstruction(
      [{ speaker: 'atc', text: 'Hongkong Shuttle 250, exit left at A7.', ts: 100_000 }],
      {
        infoBoxes: [{ title: 'Cleared for Landing', info: '08' }],
        infoBoxesAt: 40_000
      }
    )!
    expect(result.actions).toEqual([])
    expect(result.fields).toEqual([])
  })
})

// Real box sets, VHHH-ZJSY flight 230, 2026-10-05 (main.log).
const boxFields = (boxes: { title: string; info: string }[]): Record<string, string> =>
  Object.fromEntries(instructionFromBoxes(boxes).fields.map((f) => [f.key, f.value]))

describe('instructionFromBoxes', () => {
  it('reads the departure clearance set with its frequency', () => {
    expect(
      boxFields([
        { title: 'Taxi to Runway', info: '07R' },
        { title: 'SID', info: 'PECA3A' },
        { title: 'Altitude Clearance', info: 'FL140' },
        { title: 'Squawk', info: '3711' },
        { title: 'Ground Frequency', info: '122.6' }
      ])
    ).toEqual({ runway: '07R', sid: 'PECA3A', climb: 'FL140', squawk: '3711', contact: 'Ground 122.6' })
  })

  it('reads the taxi set: route, holding point, ATIS', () => {
    expect(
      boxFields([
        { title: 'Taxi to Runway', info: '07R' },
        ...['B', 'B', 'V', 'H', 'J'].map((info, i) => ({ title: `Taxi Via ${i + 1}`, info })),
        { title: 'Hold Position', info: 'J1' },
        { title: 'ATIS Current', info: 'R' }
      ])
    ).toEqual({ runway: '07R', holdingPoint: 'J1', atis: 'R', taxiVia: 'B, B, V, H, J' })
  })

  it('reads pushback, takeoff and landing as actions with their facts', () => {
    expect(instructionFromBoxes([{ title: 'Pushback Direction', info: 'southwest' }])).toEqual({
      actions: ['pushback'],
      fields: [{ key: 'face', value: 'southwest' }]
    })
    expect(instructionFromBoxes([{ title: 'Cleared for Takeoff', info: '07R' }])).toEqual({
      actions: ['takeoff'],
      fields: [{ key: 'runway', value: '07R' }]
    })
    expect(instructionFromBoxes([{ title: 'Cleared for Landing', info: '08' }]).actions).toEqual(['land'])
  })

  it('reads levels in either unit and case, a bare frequency, QNH without its label', () => {
    expect(boxFields([{ title: 'climb', info: 'FL180' }])).toEqual({ climb: 'FL180' })
    expect(
      boxFields([
        { title: 'Descend to', info: '3,000m' },
        { title: 'QNH', info: 'QNH 1014' }
      ])
    ).toEqual({ descend: '3,000 m', qnh: '1014' })
    expect(boxFields([{ title: ' Frequency', info: '123.8' }])).toEqual({ contact: '123.8' })
  })

  it('reads the arrival sets: STAR, approach, transition, gate', () => {
    expect(
      boxFields([
        { title: 'STAR', info: 'UPRS2C' },
        { title: 'Arrival Runway', info: '08' }
      ])
    ).toEqual({ star: 'UPRS2C', runway: '08' })
    expect(
      boxFields([
        { title: 'Landing Runway', info: '08' },
        { title: 'Transition', info: 'SY498' }
      ])
    ).toEqual({ runway: '08', transition: 'SY498' })
    expect(boxFields([{ title: 'Cleared Approach', info: 'ILS-Z approach runway 08' }])).toEqual({
      approach: 'ILS Z 08'
    })
    expect(
      boxFields([
        { title: 'Taxi to Gate', info: 'Gate 102' },
        { title: 'Taxi Via 1', info: 'A4' },
        { title: 'Taxi Via 2', info: 'D' }
      ])
    ).toEqual({
      stand: '102',
      taxiVia: 'A4, D'
    })
    expect(boxFields([{ title: 'Expect Gate', info: 'Gate 102' }])).toEqual({ stand: '102' })
  })

  it('ignores speeds and unknown boxes', () => {
    expect(
      boxFields([
        { title: 'Reduce Speed', info: '220' },
        { title: 'CTAF / UNICOM', info: 'No ATC on frequency' }
      ])
    ).toEqual({})
  })
})
