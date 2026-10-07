/**
 * The ATC corpus (winglog-backend docs/plans/robustness/scenario-testing.md Part 4): every line BeyondATC's air traffic control
 * has said that is on disk, run through the readers WingLog has, to find lines that look like a clearance but that nothing
 * understood. Pure: the CLI (atc-corpus.ts) reads the files and prints the report.
 */
import type { BeyondAtcInfoBox } from '@shared/ipc'
import { parseAtcBoxClearance } from '@shared/atc-info-boxes'
import { parseTaxiHoldShortRunway } from '@shared/taxi-route-parser'
import { instructionFromBoxes, parseAtcInstruction } from '../src/renderer/src/beyond-atc-instruction'

/** One line ATC said, and where it came from. */
export interface CorpusLine {
  source: string
  text: string
  /** The InfoBoxes live when it was said, where a capture has them; null otherwise. */
  boxes: BeyondAtcInfoBox[] | null
}

export type Verdict =
  /** The speech readers found something in it (station, cleared-to airport, direct, wind, an action, a hold short). */
  | 'understood'
  /** Its facts are carried by InfoBoxes (shown to be, where boxes were captured; otherwise assumed from the wording). */
  | 'box-carried'
  /** Nothing in it that looks like a clearance. */
  | 'not-a-clearance'
  /** Looks like a clearance, and nothing understood it. */
  | 'not-understood'

/** Words that make a line look like a clearance or an instruction. */
const CLEARANCE_WORDS =
  /\b(cleared|clearance|taxi|runway|via|stand|gate|squawk|hold short|line up|pushback|push|contact|descend|climb|maintain|heading|direct|approach|expect|report|proceed|continue)\b/i

/** The pilot's own calls and ATC's acknowledgements: no clearance to read. */
const CALL_OR_ACKNOWLEDGEMENT =
  /\b(request|passing|with information|report ready|say runway|have a good|good day|roger)\b/i

/**
 * The wording of lines whose facts BeyondATC also gives as InfoBoxes, so the speech readers are right to leave them: a SID or
 * STAR clearance, taxi, a frequency change, a squawk, a level, takeoff or landing, pushback, the runway and approach.
 * Used only where no boxes were captured with the line.
 */
const BOX_CARRIED_WORDING =
  /\b(cleared to .+ via|departure,? runway|taxi (?:to|via)|(?:contact )?(?:[A-Za-z]+ ){1,3}\d{3}\.\d+|squawk \d{4}|(?:continue )?climb (?:to |and maintain )?(?:FL ?)?\d+|descend (?:via STAR )?(?:to|and maintain)|maintain|cross \w+ at|cleared for (?:takeoff|landing|the approach)|cleared (?:ILS|RNAV|R-NAV|visual|LOC|VOR)|pushback approved|runway \d{1,2}[LRC]?|arrival|STAR)\b/i

/**
 * The `[Instruction]` lines in a BeyondATC `Player.log`.
 *
 * @param log The log's text.
 * @param source Where it came from, for the report.
 * @returns One corpus line per instruction.
 */
export function instructionLinesFromPlayerLog(log: string, source: string): CorpusLine[] {
  const lines: CorpusLine[] = []
  for (const raw of log.split(/\r?\n/)) {
    const match = /^\[Instruction\]\s*(.+)$/.exec(raw)
    const text = match?.[1]?.trim()
    if (text) lines.push({ source, text, boxes: null })
  }
  return lines
}

/**
 * The ATC lines in a dev-build capture (NDJSON), each with the InfoBoxes that were live when it was said.
 *
 * @param ndjson The capture's text.
 * @param source Where it came from, for the report.
 * @returns One corpus line per ATC line.
 */
export function atcLinesFromCapture(ndjson: string, source: string): CorpusLine[] {
  const lines: CorpusLine[] = []
  let boxes: BeyondAtcInfoBox[] | null = null
  for (const raw of ndjson.split('\n')) {
    if (!raw.trim()) continue
    let event: { type?: string; direction?: string; text?: string }
    try {
      event = JSON.parse(raw) as typeof event
    } catch {
      continue
    }
    if (event.type !== 'beyondatc' || event.direction !== 'in' || typeof event.text !== 'string') continue
    for (const wire of event.text.split(/\r?\n/)) {
      const infoBoxes = /^InfoBoxes:\s*(\[.*\])\s*$/.exec(wire)?.[1]
      if (infoBoxes) {
        boxes = readBoxes(infoBoxes)
        continue
      }
      const atc = /^ATC:\s*(.+)$/.exec(wire)?.[1]?.trim()
      if (atc) lines.push({ source, text: atc, boxes })
    }
  }
  return lines
}

/**
 * @param json The JSON array after `InfoBoxes:`.
 * @returns The well-formed boxes in it, or null when it isn't an array.
 */
function readBoxes(json: string): BeyondAtcInfoBox[] | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    return parsed.flatMap((b: unknown) => {
      const box = b as { title?: unknown; info?: unknown }
      return typeof box.title === 'string' && typeof box.info === 'string'
        ? [{ title: box.title, info: box.info }]
        : []
    })
  } catch {
    return null
  }
}

/**
 * What the readers make of one line.
 *
 * @param line The line, with its boxes if it has them.
 * @returns The verdict, and the reason in a few words.
 */
export function classifyLine(line: CorpusLine): { verdict: Verdict; why: string } {
  const speech = parseAtcInstruction(line.text)
  if (speech.fields.length > 0 || speech.actions.length > 0 || parseTaxiHoldShortRunway(line.text)) {
    return { verdict: 'understood', why: 'the speech readers found a fact in it' }
  }
  if (!CLEARANCE_WORDS.test(line.text)) return { verdict: 'not-a-clearance', why: 'no clearance wording' }
  if (CALL_OR_ACKNOWLEDGEMENT.test(line.text))
    return { verdict: 'not-a-clearance', why: 'a pilot call or an acknowledgement' }
  if (line.boxes) {
    const fromBoxes = instructionFromBoxes(line.boxes)
    const carried =
      parseAtcBoxClearance(line.boxes) !== null || fromBoxes.fields.length > 0 || fromBoxes.actions.length > 0
    return carried
      ? { verdict: 'box-carried', why: 'the live InfoBoxes carry its facts' }
      : { verdict: 'not-understood', why: 'boxes were captured with it and nothing in them was understood' }
  }
  return BOX_CARRIED_WORDING.test(line.text)
    ? {
        verdict: 'box-carried',
        why: 'wording of a fact BeyondATC also gives as an InfoBox (assumed: no boxes captured)'
      }
    : { verdict: 'not-understood', why: 'looks like a clearance, no boxes captured, no reader matches' }
}

/**
 * A line with its callsign, numbers and idents blanked, so the same kind of line groups together.
 *
 * @param text A line.
 * @returns Its shape.
 */
export function shapeOf(text: string): string {
  return text
    .replace(/\b[A-Z][A-Za-z]+(?: [A-Z][a-z]+)* \d{1,4}(?: Heavy| Super)?\b/g, '<callsign>')
    .replace(/\b\d+(?:[.,]\d+)?\b/g, '<n>')
    .replace(/\b[A-Z]{2,}[A-Z0-9]*\b/g, '<ID>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One group of lines sharing a shape. */
export interface ShapeGroup {
  shape: string
  count: number
  example: string
  sources: string[]
}

/** The corpus report. */
export interface CorpusSummary {
  total: number
  counts: Record<Verdict, number>
  notUnderstood: ShapeGroup[]
  assumedBoxCarried: ShapeGroup[]
}

/**
 * Classifies every line and groups the ones that need a look.
 *
 * @param lines The corpus.
 * @returns Counts per verdict, and the not-understood lines (and those only assumed box-carried) grouped by shape.
 */
export function summarise(lines: CorpusLine[]): CorpusSummary {
  const counts: Record<Verdict, number> = {
    understood: 0,
    'box-carried': 0,
    'not-a-clearance': 0,
    'not-understood': 0
  }
  const notUnderstood = new Map<string, ShapeGroup>()
  const assumed = new Map<string, ShapeGroup>()
  for (const line of lines) {
    const { verdict, why } = classifyLine(line)
    counts[verdict]++
    const target =
      verdict === 'not-understood'
        ? notUnderstood
        : verdict === 'box-carried' && why.includes('assumed')
          ? assumed
          : null
    if (!target) continue
    const shape = shapeOf(line.text)
    const group = target.get(shape) ?? { shape, count: 0, example: line.text, sources: [] }
    group.count++
    if (!group.sources.includes(line.source)) group.sources.push(line.source)
    target.set(shape, group)
  }
  const byCount = (a: ShapeGroup, b: ShapeGroup): number => b.count - a.count
  return {
    total: lines.length,
    counts,
    notUnderstood: [...notUnderstood.values()].sort(byCount),
    assumedBoxCarried: [...assumed.values()].sort(byCount)
  }
}

/**
 * The report as Markdown.
 *
 * @param summary The summary.
 * @returns The report text.
 */
export function formatSummary(summary: CorpusSummary): string {
  const out: string[] = ['# ATC corpus', '', `${summary.total} lines.`, '']
  for (const [verdict, n] of Object.entries(summary.counts)) out.push(`- ${verdict}: ${n}`)
  const section = (title: string, groups: ShapeGroup[]): void => {
    out.push('', `## ${title} (${groups.length} shapes)`, '')
    if (groups.length === 0) out.push('None.')
    for (const g of groups) out.push(`- x${g.count} \`${g.example}\` (${g.sources.join(', ')})`)
  }
  section('Looks like a clearance, nothing understood', summary.notUnderstood)
  section('Assumed carried by InfoBoxes (no boxes captured with the line)', summary.assumedBoxCarried)
  return out.join('\n') + '\n'
}
