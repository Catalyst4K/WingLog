/**
 * The key facts from BeyondATC's most recent ATC instruction, for the panel's "Latest
 * instruction" card — Callum's call, 2026-09-30: whatever ATC said last (clearance, taxi,
 * handoff, climb/descent, takeoff…) pulled out into clearly labelled fields, rather than a
 * readout accumulated across the whole flight.
 *
 * Every fact BeyondATC gives an InfoBox for comes from the boxes (instructionFromBoxes), never
 * from parsing the speech (winglog-backend's docs/decisions.md, 2026-10-05). The speech is
 * parsed only for what has no box (real VHHH-ZJSY flight, 2026-10-05): the station, the
 * cleared-to airport, "direct", wind, and the line-up / hold-short / readback-correct /
 * radar-identified labels. The card always shows the full spoken text too.
 */

import type { BeyondAtcInfoBox, BeyondAtcState, BeyondAtcTranscriptEntry } from '@shared/ipc'
import {
  boxClearedLevelFt,
  clearedApproachIdent,
  normaliseTitle,
  parseAtcTaxiFacts,
  withoutLabel
} from '@shared/atc-info-boxes'
import { itemAt } from '@shared/item-at'

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
  'takeoff' | 'land' | 'lineUp' | 'holdShort' | 'pushback' | 'readbackCorrect' | 'identified'

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

const FACILITY_WORDS =
  'Delivery|Clearance|Ground|Apron|Tower|Departure|Approach|Arrival|Director|Radar|Control|Center|Centre'
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
  const fl = /^FL ?(\d{2,3})$/i.exec(raw)?.[1]
  if (fl) return `FL${fl.padStart(3, '0')}`
  const metric = /^([\d,]+) ?(?:m|meters|metres)$/i.exec(raw)?.[1]
  if (metric) return `${Number(metric.replace(/,/g, '')).toLocaleString('en')} m`
  const feet = /^([\d,]+) ?(?:feet|ft)$/i.exec(raw)?.[1]
  if (feet) return `${Number(feet.replace(/,/g, '')).toLocaleString('en')} ft`
  return raw
}

/**
 * The facts in one spoken ATC line that BeyondATC has no InfoBox for.
 *
 * @param text ATC's spoken line.
 * @returns Its actions and labelled fields.
 */
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

const RUNWAY_TITLES = [
  'taxi to runway',
  'arrival runway',
  'landing runway',
  'cleared for takeoff',
  'cleared for landing'
]
const DESCEND_TITLES = ['descend', 'descend to']
const RUNWAY_IDENT = /^\d{1,2}[LRC]?$/

type BoxField = (value: string) => [InstructionFieldKey, string | null]

// The field each InfoBox title fills, by normalised title. A Map, not an object: the titles
// are BeyondATC's, so one could be "constructor".
const BOX_FIELDS = new Map<string, BoxField>([
  ['atis current', (value) => ['atis', value.toUpperCase()]],
  ['sid', (value) => ['sid', value.toUpperCase()]],
  ['star', (value) => ['star', value.toUpperCase()]],
  ['cleared approach', (value) => ['approach', clearedApproachIdent(value)]],
  ['transition', (value) => ['transition', value.toUpperCase()]],
  ...RUNWAY_TITLES.map((title): [string, BoxField] => [title, (value) => ['runway', value.toUpperCase()]]),
  ['qnh', (value) => ['qnh', withoutLabel(value, 'QNH')]],
  ['squawk', (value) => ['squawk', value]],
  ['pushback direction', (value) => ['face', value.toLowerCase()]]
])

/** The action each InfoBox title is, by normalised title. */
const BOX_ACTIONS = new Map<string, InstructionAction>([
  ['cleared for takeoff', 'takeoff'],
  ['cleared for landing', 'land'],
  ['pushback direction', 'pushback']
])

/**
 * @param box The InfoBox.
 * @param title Its normalised title.
 * @param value Its value, trimmed.
 * @returns The field it fills, or null. Any "… Frequency" box is a contact.
 */
function boxField(
  box: BeyondAtcInfoBox,
  title: string,
  value: string
): [InstructionFieldKey, string | null] | null {
  const field = BOX_FIELDS.get(title)
  if (field) return field(value)
  if (title.endsWith('frequency'))
    return ['contact', `${box.title.trim().replace(/ ?frequency$/i, '')} ${value}`.trim()]
  return null
}

/**
 * One set of InfoBoxes as the card's labelled fields and actions.
 *
 * @param boxes One set of InfoBoxes.
 * @returns Their actions and labelled fields.
 */
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
    const field = boxField(box, title, value)
    if (field) add(...field)
    const action = BOX_ACTIONS.get(title)
    if (action) actions.push(action)
    if (boxClearedLevelFt([box]) !== null)
      add(DESCEND_TITLES.includes(title) ? 'descend' : 'climb', formatAltitude(value))
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
 *
 * @param entries The transcript.
 * @param boxes The current InfoBoxes and when they last changed.
 * @returns The latest instruction, or null.
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
  return {
    ...instruction,
    actions: [...instruction.actions, ...boxed.actions],
    fields: [...instruction.fields, ...boxed.fields]
  }
}

function latestSpokenInstruction(entries: BeyondAtcTranscriptEntry[]): AtcInstruction | null {
  const readbacks: AtcInstruction[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = itemAt(entries, i, 'transcript entry')
    if (entry.speaker !== 'atc') continue
    const instruction = { text: entry.text, ts: entry.ts, ...parseAtcInstruction(entry.text) }
    if (!isReadbackOnly(instruction)) return readbacks.reduceRight(applyReadback, instruction)
    readbacks.push(instruction)
  }
  return readbacks[0] ?? null
}

/**
 * "readback correct. Contact ground 122.25 when ready for pushback or engine start." (real,
 * VHHH 2026-10-02) — confirms the line before rather than replacing it.
 *
 * @param instruction An instruction.
 * @returns True if it only confirms the one before.
 */
function isReadbackOnly(instruction: AtcInstruction): boolean {
  return (
    instruction.actions.length === 1 &&
    instruction.actions[0] === 'readbackCorrect' &&
    instruction.fields.every((f) => f.key === 'station')
  )
}

/**
 * Callum, 2026-10-02: a readback keeps the instruction it confirms on the card (the clearance
 * stays up until ATC says something new, e.g. pushback approved). The full text shows both
 * lines; the frequency it hands over comes from the boxes (`Ground Frequency`).
 *
 * @param confirmed The instruction being confirmed.
 * @param readback The readback line.
 * @returns The confirmed instruction, with both lines' text.
 */
function applyReadback(confirmed: AtcInstruction, readback: AtcInstruction): AtcInstruction {
  return { ...confirmed, text: `${confirmed.text} ${readback.text}`, ts: readback.ts }
}
