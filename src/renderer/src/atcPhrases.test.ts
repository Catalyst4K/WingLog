import { describe, expect, it } from 'vitest'
import { parseAtcClearance } from './atcClearanceParser'
import { parseAtcInstruction } from './beyondAtcInstruction'

/** Every real BeyondATC procedure wording on record (flightdeck-backend's beyondatc-notes.md
 *  and Player.log captures). Add new ones here as they turn up — both parsers are checked
 *  against each, so the Latest instruction card and the procedure prompt can't disagree. */
const DEPARTURES = [
  {
    text: 'Cathay 168 Heavy, Brisbane Delivery, information A current, cleared to Hong Kong airport via the BIXAD2 departure, runway 01R, climb via SID to 10000 feet, squawk 6022.',
    sid: 'BIXAD2',
    runway: '01R',
    clearedTo: 'Hong Kong airport'
  },
  {
    text: 'Hongkong Shuttle 250, Hong Kong Delivery, information H current, cleared to Phoenix airport via PECA1D departure, runway 25C, climb via SID to FL140, squawk 6140.',
    sid: 'PECA1D',
    runway: '25C',
    clearedTo: 'Phoenix airport'
  },
  {
    text: 'Singapore 830 Super, Singapore Delivery, information I current, cleared to Pudong airport via VMR9F departure, runway 20R, climb via SID to 11000 feet, squawk 1151.',
    sid: 'VMR9F',
    runway: '20R',
    clearedTo: 'Pudong airport'
  },
  {
    text: 'Test 830, Test Delivery, cleared to Pudong via VMR9B departure, runway 20C, climb via SID to 11000 feet, squawk 3136.',
    sid: 'VMR9B',
    runway: '20C',
    clearedTo: 'Pudong'
  },
  // Not seen yet — the variants the tolerant patterns exist for.
  { text: 'Test 830, cleared to Pudong via the VMR9B SID, runway 20C, squawk 3136.', sid: 'VMR9B', runway: '20C', clearedTo: 'Pudong' }
]

const ARRIVALS = [
  { text: 'Cathay 168 Heavy, cleared BETY3B arrival, runway 25L.', star: 'BETY3B' },
  { text: 'Test 830, cleared AND1 arrival, runway 17R.', star: 'AND1' },
  { text: 'Test 830, cleared the AND1 arrival, runway 17R.', star: 'AND1' }
]

const APPROACHES = [
  { text: 'Cathay 168 Heavy Hong Kong Approach, QNH 1011 expect the ILS approach runway 25L.', approach: 'ILS 25L' },
  {
    text: 'Test 830 Test Approach, QNH 1012 expect the ILS-Z approach runway 17R with the PD201 transition.',
    approach: 'ILS Z 17R',
    transition: 'PD201'
  },
  { text: 'Cathay 168 Heavy, cleared direct RIVMI, cross RIVMI at or above 4,500, cleared ILS approach runway 25L.', approach: 'ILS 25L' },
  { text: 'Test 830, cleared direct PD201, cross PD201 at or above 900m, cleared ILS-Z approach runway 17R.', approach: 'ILS Z 17R' }
]

const field = (text: string, key: string): string | undefined => parseAtcInstruction(text).fields.find((f) => f.key === key)?.value

describe('real BeyondATC procedure wordings', () => {
  it.each(DEPARTURES)('departure: $text', ({ text, sid, runway, clearedTo }) => {
    expect(parseAtcClearance(text)?.fields).toEqual({ sidIdent: sid, departureRunway: runway })
    expect(field(text, 'sid')).toBe(sid)
    expect(field(text, 'runway')).toBe(runway)
    expect(field(text, 'clearedTo')).toBe(clearedTo)
  })

  it.each(ARRIVALS)('arrival: $text', ({ text, star }) => {
    expect(parseAtcClearance(text)?.fields).toEqual({ starIdent: star })
    expect(field(text, 'star')).toBe(star)
  })

  it.each(APPROACHES)('approach: $text', ({ text, approach, transition }) => {
    expect(parseAtcClearance(text)?.fields).toEqual(transition ? { approachIdent: approach, approachTransition: transition } : { approachIdent: approach })
    expect(field(text, 'approach')).toBe(approach)
  })

  it('keeps what it can read when one piece is missing, rather than dropping the whole clearance', () => {
    expect(parseAtcClearance('Test 830, cleared to Pudong via radar vectors, runway 20C, squawk 3136.')).toEqual({
      fields: { departureRunway: '20C' },
      summary: 'runway 20C'
    })
  })

  it('ignores lines that only look similar', () => {
    for (const text of [
      'Cathay 168 Heavy, wind 280 degrees, 8 knots, runway 25L cleared to land.',
      'Cathay 168 Heavy, readback correct. Contact ground 122.25 when ready for pushback or engine start.',
      'Cathay 168 Heavy, descend via STAR to 4,500, QNH 1011.'
    ]) {
      expect(parseAtcClearance(text)).toBeNull()
    }
  })
})
