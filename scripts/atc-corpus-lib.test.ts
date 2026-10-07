import { describe, expect, it } from 'vitest'
import {
  atcLinesFromCapture,
  classifyLine,
  formatSummary,
  instructionLinesFromPlayerLog,
  shapeOf,
  summarise,
  type CorpusLine
} from './atc-corpus-lib'

const line = (text: string, boxes: CorpusLine['boxes'] = null): CorpusLine => ({
  source: 'test',
  text,
  boxes
})

describe('instructionLinesFromPlayerLog', () => {
  it('takes only the [Instruction] lines, trimmed, and skips empty ones', () => {
    const log = [
      '[Comms] something else',
      '[Instruction] Hongkong Shuttle 251, readback correct. Contact ground 121.7 when ready for push or start.',
      '[Instruction]   ',
      '[GSX] not ATC',
      '[Instruction] Pushback approved, Face south, Hongkong Shuttle 251.'
    ].join('\r\n')
    expect(instructionLinesFromPlayerLog(log, 'Player.log').map((l) => l.text)).toEqual([
      'Hongkong Shuttle 251, readback correct. Contact ground 121.7 when ready for push or start.',
      'Pushback approved, Face south, Hongkong Shuttle 251.'
    ])
  })
})

describe('atcLinesFromCapture', () => {
  it('tags each ATC line with the InfoBoxes that were live when it was said', () => {
    const boxes = JSON.stringify([{ title: 'Taxi Via 1', info: 'D' }, { title: 'bad' }])
    const ndjson = [
      JSON.stringify({ scenario: 'header' }),
      JSON.stringify({ type: 'beyondatc', direction: 'in', text: 'ATC: Hold position.' }),
      JSON.stringify({ type: 'beyondatc', direction: 'in', text: `InfoBoxes: ${boxes}\nATC: Taxi via D.` }),
      JSON.stringify({ type: 'beyondatc', direction: 'out', text: 'ATC: not from BeyondATC' }),
      JSON.stringify({ type: 'sim', data: {} }),
      'not json'
    ].join('\n')
    const lines = atcLinesFromCapture(ndjson, 'flight-1.ndjson')
    expect(lines).toEqual([
      { source: 'flight-1.ndjson', text: 'Hold position.', boxes: null },
      { source: 'flight-1.ndjson', text: 'Taxi via D.', boxes: [{ title: 'Taxi Via 1', info: 'D' }] }
    ])
  })
})

describe('classifyLine', () => {
  it('understands what the speech readers read: a hold short, the station, a wind', () => {
    expect(classifyLine(line('Test 230, taxi via E, F, hold short of runway 27L.')).verdict).toBe(
      'understood'
    )
    expect(
      classifyLine(
        line(
          'Hongkong Shuttle 251, Fenghuang Delivery, information G correct, cleared to Hong Kong via PORA1N departure, runway 08.'
        )
      ).verdict
    ).toBe('understood')
  })

  it('leaves the pilot calls, acknowledgements and small talk alone', () => {
    for (const text of [
      'Hongkong Shuttle 251, request taxi.',
      'Hongkong Shuttle 251, roger, say runway.',
      'Hongkong Shuttle 251, contact ground 121.6, have a good morning.',
      'Hongkong Shuttle 251, good morning.'
    ]) {
      expect(classifyLine(line(text)).verdict).toBe('not-a-clearance')
    }
  })

  it('takes the wording of a fact BeyondATC also gives as a box as carried by the boxes, saying it is assumed', () => {
    for (const text of [
      'Pushback approved, Face south, Hongkong Shuttle 251.',
      'Hongkong Shuttle 251, taxi to holding point A, runway 08, via D, B7, A.',
      'Hongkong Shuttle 251, contact Sanya Departure 127.925.',
      'Continue climb to FL371, Hongkong Shuttle 251.',
      'Climb 11,300m, Hongkong Shuttle 251.',
      'Hongkong Shuttle 251, cleared CANT3A arrival, runway 07L.',
      'Runway 08, cleared for takeoff, Hongkong Shuttle 251.'
    ]) {
      const result = classifyLine(line(text))
      expect(result.verdict, text).toBe('box-carried')
      expect(result.why).toContain('assumed')
    }
  })

  it('flags a line that looks like a clearance when nothing reads it and no boxes were captured', () => {
    expect(classifyLine(line('Hongkong Shuttle 251, proceed to the frobnicator and wait.')).verdict).toBe(
      'not-understood'
    )
  })

  it('checks the live boxes when a capture has them: carried when they read, flagged when they do not', () => {
    const taxi = [
      { title: 'Taxi Via 1', info: 'D' },
      { title: 'Hold Position', info: 'A' }
    ]
    expect(classifyLine(line('Hongkong Shuttle 251, proceed as cleared.', taxi))).toMatchObject({
      verdict: 'box-carried'
    })
    const unread = [{ title: 'Something New', info: 'x' }]
    expect(classifyLine(line('Hongkong Shuttle 251, proceed as cleared.', unread))).toMatchObject({
      verdict: 'not-understood'
    })
  })
})

describe('shapeOf', () => {
  it('blanks the callsign, numbers and idents so the same kind of line groups together', () => {
    expect(shapeOf('Hongkong Shuttle 251, descend to FL140.')).toBe(shapeOf('Speedbird 32, descend to FL90.'))
    expect(shapeOf('Contact Sanya Control 133.2')).toContain('<n>')
  })
})

describe('summarise and formatSummary', () => {
  it('counts every verdict, groups the unread lines by shape, and prints them', () => {
    const lines = [
      line('Hongkong Shuttle 251, proceed to the frobnicator and wait.'),
      line('Speedbird 32, proceed to the quuxifier and wait.'),
      line('Pushback approved, Face south, Hongkong Shuttle 251.'),
      line('Hongkong Shuttle 251, good morning.')
    ]
    const summary = summarise(lines)
    expect(summary.total).toBe(4)
    expect(summary.counts).toEqual({
      understood: 0,
      'box-carried': 1,
      'not-a-clearance': 1,
      'not-understood': 2
    })
    expect(summary.assumedBoxCarried).toHaveLength(1)
    const report = formatSummary(summary)
    expect(report).toContain('4 lines.')
    expect(report).toContain('frobnicator')
    expect(formatSummary(summarise([]))).toContain('None.')
  })
})
