import type { BeyondAtcInfoBox, BeyondAtcState, BeyondAtcTranscriptEntry } from '@shared/ipc'
import { boxClearedLevelFt, clearedApproachIdent, normaliseTitle, parseAtcTaxiFacts, withoutLabel } from '@shared/atc-info-boxes'

/**
 * The key facts from BeyondATC's most recent ATC instruction, for the panel's "Latest
 * instruction" card — Callum's call, 2026-09-30: whatever ATC said last (clearance, taxi,
 * handoff, climb/descent, takeoff…) pulled out into clearly labelled fields, rather than a
 * readout accumulated across the whole flight.
 *
 * Every fact BeyondATC gives an InfoBox for comes from the boxes (instructionFromBoxes), never
 * from parsing the speech (flightdeck-backend's docs/decisions.md, 2026-10-05). The speech is
 * parsed only for what has no box (real VHHH-ZJSY flight, 2026-10-05): the station, the
 * cleared-to airport, "direct", wind, and the line-up / hold-short / readback-correct /
 * radar-identified labels. The card always shows the full spoken text too.
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
// A departure clearance: "cleared to Hong Kong airport via …".
const CLEARED_TO = /\bcleared to (.+?) via /i
// Fix names can carry digits (PD201, a real RNAV fix at ZSPD).
const DIRECT = /\bdirect ([A-Z][A-Z0-9]{1,4})\b/
const WIND = /wind (\d{3}) degrees,? (\d+) knots/i

/** Labels with no InfoBox. Takeoff, landing and pushback come from their boxes. */
const ACTIONS: [InstructionAction, RegExp][] = [
  ['lineUp', /line ?up and wait/i],
  ['holdShort', /hold short of runway/i],
  ['readbackCorrect', /readback correct/i],
  ['identified', /\bidentified\b/i]
]

function formatAltitude(raw: string): string {
  const fl = /^FL ?(\d{2,3})$/i.exec(raw)
  if (fl) return `FL${fl[1]!.padStart(3, '0')}`
  const metric = /^([\d,]+) ?(?:m|meters|metres)$/i.exec(raw)
  if (metric) return `${Number(metric[1]!.replace(/,/g, '')).toLocaleString('en')} m`
  const feet = /^([\d,]+) ?(?:feet|ft)$/i.exec(raw)
  if (feet) return `${Number(feet[1]!.replace(/,/g, '')).toLocaleString('en')} ft`
  return raw
}

/** The facts in one spoken ATC line that BeyondATC has no InfoBox for. */
export function parseAtcInstruction(text: string): Pick<AtcInstruction, 'actions' | 'fields'> {
  const fields: InstructionField[] = []
  const add = (key: InstructionFieldKey, value: string | undefined): void => {
    if (value) fields.push({ key, value })
  }
  add('station', STATION.exec(text)?.[1])
  add('clearedTo', CLEARED_TO.exec(text)?.[1])
  add('direct', DIRECT.exec(text)?.[1])
  const wind = WIND.exec(text)
  if (wind) add('wind', `${wind[1]}° ${wind[2]} kt`)
  const actions = ACTIONS.filter(([, pattern]) => pattern.test(text)).map(([action]) => action)
  return { actions, fields }
}

/** How long before an ATC line its boxes may have changed and still count as its own: BeyondATC
 *  updates the boxes and speaks within a second or two of each other. */
const BOXES_WITH_LINE_MS = 15_000

const RUNWAY_TITLES = ['taxi to runway', 'arrival runway', 'landing runway', 'cleared for takeoff', 'cleared for landing']
const DESCEND_TITLES = ['descend', 'descend to']
const RUNWAY_IDENT = /^\d{1,2}[LRC]?$/

/** One set of InfoBoxes as the card's labelled fields and actions. */
export function instructionFromBoxes(boxes: BeyondAtcInfoBox[]): Pick<AtcInstruction, 'actions' | 'fields'> {
  const fields: InstructionField[] = []
  const actions: InstructionAction[] = []
  const add = (key: InstructionFieldKey, value: string | null | undefined): void => {
    if (value && !fields.some((f) => f.key === key)) fields.push({ key, value })
  }
  for (const box of boxes) {
    const title = normaliseTitle(box.title)
    const value = box.info.trim()
    if (!value) continue
    if (title === 'atis current') add('atis', value.toUpperCase())
    else if (title === 'sid') add('sid', value.toUpperCase())
    else if (title === 'star') add('star', value.toUpperCase())
    else if (title === 'cleared approach') add('approach', clearedApproachIdent(value))
    else if (title === 'transition') add('transition', value.toUpperCase())
    else if (RUNWAY_TITLES.includes(title)) add('runway', value.toUpperCase())
    else if (title === 'qnh') add('qnh', withoutLabel(value, 'QNH'))
    else if (title === 'squawk') add('squawk', value)
    else if (title.endsWith('frequency')) add('contact', `${box.title.trim().replace(/ ?frequency$/i, '')} ${value}`.trim())
    else if (title === 'pushback direction') add('face', value.toLowerCase())
    if (title === 'cleared for takeoff') actions.push('takeoff')
    if (title === 'cleared for landing') actions.push('land')
    if (title === 'pushback direction') actions.push('pushback')
    if (boxClearedLevelFt([box]) !== null) add(DESCEND_TITLES.includes(title) ? 'descend' : 'climb', formatAltitude(value))
  }
  const taxi = parseAtcTaxiFacts(boxes)
  if (taxi.holdPosition && !RUNWAY_IDENT.test(taxi.holdPosition)) add('holdingPoint', taxi.holdPosition)
  add('stand', taxi.taxiToGate ?? taxi.expectGate)
  if (taxi.taxiVia.length > 0) add('taxiVia', taxi.taxiVia.join(', '))
  return { actions, fields }
}

/**
 * The most recent line ATC spoke to us (never another aircraft's traffic), or null before ATC
 * has said anything: its speech-only facts, plus the InfoBoxes when they changed around the
 * time of that line. An older box set belongs to an earlier instruction ("exit left at A7" has
 * no box, and mustn't show the landing clearance's).
 */
export function latestAtcInstruction(
  entries: BeyondAtcTranscriptEntry[],
  boxes: Pick<BeyondAtcState, 'infoBoxes' | 'infoBoxesAt'>
): AtcInstruction | null {
  const instruction = latestSpokenInstruction(entries)
  if (!instruction) return null
  const current = boxes.infoBoxesAt !== null && boxes.infoBoxesAt >= instruction.ts - BOXES_WITH_LINE_MS
  if (!current) return instruction
  const boxed = instructionFromBoxes(boxes.infoBoxes)
  return { ...instruction, actions: [...instruction.actions, ...boxed.actions], fields: [...instruction.fields, ...boxed.fields] }
}

function latestSpokenInstruction(entries: BeyondAtcTranscriptEntry[]): AtcInstruction | null {
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
    instruction.fields.every((f) => f.key === 'station')
  )
}

/** Callum, 2026-10-02: a readback keeps the instruction it confirms on the card (the clearance
 *  stays up until ATC says something new, e.g. pushback approved). The full text shows both
 *  lines; the frequency it hands over comes from the boxes (`Ground Frequency`). */
function applyReadback(confirmed: AtcInstruction, readback: AtcInstruction): AtcInstruction {
  return { ...confirmed, text: `${confirmed.text} ${readback.text}`, ts: readback.ts }
}
