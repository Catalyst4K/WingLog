import type { BeyondAtcTranscriptEntry } from '@shared/ipc'
import { APPROACH_CLEARED, APPROACH_EXPECT, CLEARED_TO, RUNWAY, SID, STAR } from '@shared/atc-phrases'
import { parseTaxiRoute } from './taxiRouteParser'

/**
 * The key facts from BeyondATC's most recent ATC instruction, for the panel's "Latest
 * instruction" card — Callum's call, 2026-09-30: whatever ATC said last (clearance, taxi,
 * handoff, climb/descent, takeoff…) pulled out into clearly labelled fields, rather than a
 * readout accumulated across the whole flight.
 *
 * Deliberately field-by-field, not one regex per whole message: any instruction yields
 * whichever facts it contains, and an unrecognised phrasing simply yields fewer fields (the
 * card always shows the full text too). Every pattern is built from real captured lines
 * (BeyondATC's Player.log, VHHH→KPHX and WSSS→ZSPD, and flightdeck-backend's
 * docs/beyondatc-notes.md) — not guessed phrasing. Headings and speed restrictions aren't
 * covered yet: no real sample has been captured.
 */

export type InstructionFieldKey =
  | 'station'
  | 'atis'
  | 'clearedTo'
  | 'sid'
  | 'star'
  | 'approach'
  | 'transition'
  | 'runway'
  | 'climb'
  | 'descend'
  | 'qnh'
  | 'squawk'
  | 'contact'
  | 'holdingPoint'
  | 'stand'
  | 'taxiVia'
  | 'direct'
  | 'wind'
  | 'face'

/** Clearances/permissions worth calling out on their own, not as a label: value pair. */
export type InstructionAction =
  | 'takeoff'
  | 'land'
  | 'lineUp'
  | 'holdShort'
  | 'pushback'
  | 'readbackCorrect'
  | 'identified'

export interface InstructionField {
  key: InstructionFieldKey
  value: string
}

export interface AtcInstruction {
  text: string
  ts: number
  actions: InstructionAction[]
  fields: InstructionField[]
}

const FACILITY_WORDS = 'Delivery|Clearance|Ground|Apron|Tower|Departure|Approach|Arrival|Director|Radar|Control|Center|Centre'
// "Hongkong Shuttle 250, Hong Kong Delivery, …" — the second comma chunk, when it's a facility.
const STATION = new RegExp(`^[^,]+, ([A-Z][A-Za-z ]*? (?:${FACILITY_WORDS})),`)
const ATIS = /information ([A-Z]) current/i
// "climb via SID to FL140", "climb FL190", "climb via SID to 11000 feet", "descend to 3,000m".
// Pilot-style "passing … climbing to …" is the pilot's own report, never an ATC line.
const ALTITUDE = /\b(climb|descend)(?: via SID)?(?: and maintain)?(?: to)? (FL ?\d{2,3}|[\d,]+ ?(?:feet|ft|m|meters|metres))\b/i
const QNH = /QNH (\d{3,4})\b/i
const SQUAWK = /squawk (\d{4})\b/i
const CONTACT = /contact ([A-Za-z][A-Za-z ]*?) (\d{3}\.\d{1,3})/i
const HOLDING_POINT = /holding point ([A-Z0-9]+)/i
const STAND = /taxi to stand ([A-Z0-9]+)/i
// Fix names can carry digits (PD201, a real RNAV fix at ZSPD).
const DIRECT = /\bdirect ([A-Z][A-Z0-9]{1,4})\b/
const WIND = /wind (\d{3}) degrees,? (\d+) knots/i
const FACE = /\bface (north|south|east|west|northeast|northwest|southeast|southwest)\b/i

const ACTIONS: [InstructionAction, RegExp][] = [
  ['takeoff', /cleared for takeoff/i],
  ['land', /cleared to land/i],
  ['lineUp', /line ?up and wait/i],
  ['holdShort', /hold short of runway/i],
  ['pushback', /pushback(?: and engine start)? approved/i],
  ['readbackCorrect', /readback correct/i],
  ['identified', /\bidentified\b/i]
]

/** BeyondATC speaks approach types hyphenated ("ILS-Z"); shown as the sim's own navdata
 *  writes them ("ILS Z 17R") — same transform as src/shared/atc-clearance-parser.ts. */
function approachIdent(type: string, runway: string): string {
  return `${type.replace('-', ' ')} ${runway}`
}

function formatAltitude(raw: string): string {
  const fl = /^FL ?(\d{2,3})$/i.exec(raw)
  if (fl) return `FL${fl[1]!.padStart(3, '0')}`
  const metric = /^([\d,]+) ?(?:m|meters|metres)$/i.exec(raw)
  if (metric) return `${Number(metric[1]!.replace(/,/g, '')).toLocaleString('en')} m`
  const feet = /^([\d,]+) ?(?:feet|ft)$/i.exec(raw)
  if (feet) return `${Number(feet[1]!.replace(/,/g, '')).toLocaleString('en')} ft`
  return raw
}

export function parseAtcInstruction(text: string): Pick<AtcInstruction, 'actions' | 'fields'> {
  const fields: InstructionField[] = []
  const add = (key: InstructionFieldKey, value: string | undefined): void => {
    if (value) fields.push({ key, value })
  }

  add('station', STATION.exec(text)?.[1])
  add('atis', ATIS.exec(text)?.[1])
  add('clearedTo', CLEARED_TO.exec(text)?.[1])
  add('sid', SID.exec(text)?.[1])
  add('star', STAR.exec(text)?.[1])

  const expect = APPROACH_EXPECT.exec(text)
  const cleared = expect ? null : APPROACH_CLEARED.exec(text)
  if (expect) {
    add('approach', approachIdent(expect[1]!, expect[2]!))
    add('transition', expect[3])
  } else if (cleared) {
    add('approach', approachIdent(cleared[1]!, cleared[2]!))
  }

  add('runway', RUNWAY.exec(text)?.[1] ?? expect?.[2] ?? cleared?.[2])

  const altitude = ALTITUDE.exec(text)
  if (altitude) add(altitude[1]!.toLowerCase() === 'climb' ? 'climb' : 'descend', formatAltitude(altitude[2]!))
  add('qnh', QNH.exec(text)?.[1])
  add('squawk', SQUAWK.exec(text)?.[1])

  const contact = CONTACT.exec(text)
  if (contact) add('contact', `${contact[1]!.trim()} ${contact[2]}`)

  add('holdingPoint', HOLDING_POINT.exec(text)?.[1])
  add('stand', STAND.exec(text)?.[1])
  add('taxiVia', parseTaxiRoute(text)?.join(', '))
  add('direct', DIRECT.exec(text)?.[1])

  const wind = WIND.exec(text)
  if (wind) add('wind', `${wind[1]}° ${wind[2]} kt`)
  add('face', FACE.exec(text)?.[1]?.toLowerCase())

  const actions = ACTIONS.filter(([, pattern]) => pattern.test(text)).map(([action]) => action)
  return { actions, fields }
}

/** The most recent line ATC spoke to us (never another aircraft's traffic), parsed — or null
 *  before ATC has said anything. */
export function latestAtcInstruction(entries: BeyondAtcTranscriptEntry[]): AtcInstruction | null {
  const readbacks: AtcInstruction[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.speaker !== 'atc') continue
    const instruction = { text: entry.text, ts: entry.ts, ...parseAtcInstruction(entry.text) }
    if (!isReadbackOnly(instruction)) return readbacks.reduceRight(applyReadback, instruction)
    readbacks.push(instruction)
  }
  return readbacks[0] ?? null
}

/** "readback correct. Contact ground 122.25 when ready for pushback or engine start." (real,
 *  VHHH 2026-10-02) — confirms the line before rather than replacing it. */
function isReadbackOnly(instruction: AtcInstruction): boolean {
  return (
    instruction.actions.length === 1 &&
    instruction.actions[0] === 'readbackCorrect' &&
    instruction.fields.every((f) => f.key === 'station' || f.key === 'contact')
  )
}

/** Callum, 2026-10-02: a readback keeps the instruction it confirms on the card (the clearance
 *  stays up until ATC says something new, e.g. pushback approved) — the only change is the
 *  frequency it hands over, if any. The full text shows both lines. */
function applyReadback(confirmed: AtcInstruction, readback: AtcInstruction): AtcInstruction {
  const contact = readback.fields.find((f) => f.key === 'contact')
  return {
    ...confirmed,
    text: `${confirmed.text} ${readback.text}`,
    ts: readback.ts,
    fields: contact ? [...confirmed.fields.filter((f) => f.key !== 'contact'), contact] : confirmed.fields
  }
}
