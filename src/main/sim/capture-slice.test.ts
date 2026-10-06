import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ANONYMOUS_ATC_ID, ANONYMOUS_CAPTURED_AT, sliceCapture } from './capture-slice'
import { formatFlightFixture, parseFlightFixture, type FlightFixtureEvent, type ParsedFlightFixture } from './flight-fixture'

const EGLL = parseFlightFixture(
  readFileSync(new URL('../tracking/__fixtures__/short-hop-egll-egcc.ndjson', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8')
)

/** Ten ticks a second apart carrying a real-looking tail number, plus the given lines. */
function capture(lines: FlightFixtureEvent[]): ParsedFlightFixture {
  const ticks = EGLL.events
    .filter((e) => e.type === 'telemetry')
    .slice(0, 10)
    .map((e, i) => (e.type === 'telemetry' ? { ...e, tOffsetMs: i * 1000, data: { ...e.data, atcId: 'B-HNR' } } : e))
  return {
    header: { scenario: 'VHHH-ZJSY', aircraftType: 'A330', capturedAt: '2026-10-05T14:30:00.000Z', notes: 'local capture' },
    events: [...ticks, ...lines].sort((a, b) => a.tOffsetMs - b.tOffsetMs)
  }
}

const CALLSIGN = 'Callsign: {"full":"Cathay 905","shortForm":"CPA905"}'

describe('sliceCapture', () => {
  it('keeps the window, restarting its offsets from the window start', () => {
    const slice = sliceCapture(capture([{ type: 'gsx', tOffsetMs: 4500, direction: 'in', text: '{"type":"patch"}' }]), {
      fromMs: 3000,
      toMs: 6000,
      scenario: 'window',
      notes: 'n'
    })
    expect(slice.events.map((e) => [e.type, e.tOffsetMs])).toEqual([
      ['telemetry', 0],
      ['telemetry', 1000],
      ['gsx', 1500],
      ['telemetry', 2000],
      ['telemetry', 3000]
    ])
  })

  it('replaces the callsign and tail number everywhere, and drops BeyondATC settings', () => {
    const slice = sliceCapture(
      capture([
        { type: 'beyondatc', tOffsetMs: 500, direction: 'in', text: `${CALLSIGN}\nSettings: {"simbriefUser":"someone"}` },
        { type: 'beyondatc', tOffsetMs: 1500, direction: 'in', text: 'ATC: cathay 905, taxi to runway 07R via B, B, V' },
        { type: 'beyondatc', tOffsetMs: 2500, direction: 'in', text: 'Settings: {"simbriefUser":"someone"}' },
        { type: 'gsx', tOffsetMs: 3500, direction: 'in', text: '{"menu":{"title":"CPA905 B-HNR at Gate N6"}}' }
      ]),
      { scenario: 'anonymised', notes: 'n', replacements: [['Gate N6', 'Gate 1']] }
    )
    const text = formatFlightFixture(slice)
    expect(text).not.toMatch(/CPA905|Cathay 905|B-HNR|simbriefUser|Gate N6/i)
    const lines = slice.events.flatMap((e) => (e.type === 'beyondatc' || e.type === 'gsx' ? [e.text] : []))
    expect(lines).toEqual([
      'Callsign: {"full":"Test 123","shortForm":"TST123"}',
      'ATC: Test 123, taxi to runway 07R via B, B, V',
      '{"menu":{"title":"TST123 G-TEST at Gate 1"}}'
    ])
    expect(slice.events.every((e) => e.type !== 'telemetry' || e.data.atcId === ANONYMOUS_ATC_ID)).toBe(true)
    expect(slice.header).toEqual({ scenario: 'anonymised', aircraftType: 'A330', capturedAt: ANONYMOUS_CAPTURED_AT, notes: 'n' })
  })

  it('keeps only the streams asked for, and always the sim', () => {
    const slice = sliceCapture(
      capture([
        { type: 'beyondatc', tOffsetMs: 500, direction: 'in', text: 'Facility: Hong Kong Ground|121.6' },
        { type: 'gsx', tOffsetMs: 600, direction: 'in', text: '{}' }
      ]),
      { streams: ['beyondatc'], scenario: 's', notes: 'n' }
    )
    expect(new Set(slice.events.map((e) => e.type))).toEqual(new Set(['telemetry', 'beyondatc']))
  })

  it('round-trips through the fixture format', () => {
    const slice = sliceCapture(capture([{ type: 'beyondatc', tOffsetMs: 500, direction: 'out', text: 'frequencies' }]), {
      scenario: 's',
      notes: 'n'
    })
    expect(parseFlightFixture(formatFlightFixture(slice))).toEqual(slice)
  })

  it('refuses a window with no telemetry', () => {
    expect(() => sliceCapture(capture([]), { fromMs: 60_000, scenario: 's', notes: 'n' })).toThrow(/No telemetry/)
  })

  it('ignores a malformed callsign line', () => {
    const slice = sliceCapture(capture([{ type: 'beyondatc', tOffsetMs: 500, direction: 'in', text: 'Callsign: {not json}' }]), {
      scenario: 's',
      notes: 'n'
    })
    expect(slice.events.some((e) => e.type === 'beyondatc' && e.text === 'Callsign: {not json}')).toBe(true)
  })
})
