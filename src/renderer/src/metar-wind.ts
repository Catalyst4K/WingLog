import type { WindSpeedUnit } from '@shared/ipc'

/** A parsed METAR wind group (e.g. "25008KT", "VRB03KT", "31015G25MPS"). Values are kept
 *  in the unit the report itself used (`sourceUnit`) — formatWind converts on display
 *  only, so a station already reporting in the selected unit never round-trips through a
 *  conversion at all. */
export interface ParsedWind {
  directionDeg: number | null
  isVariable: boolean
  speedValue: number
  gustValue: number | null
  sourceUnit: WindSpeedUnit
}

// Matches a standard METAR wind group: 3-digit true direction or VRB, 2-3 digit speed, an
// optional G<gust> group, then the unit — KT (the vast majority of stations, including all
// North American ones) or MPS (common outside North America). Word-bounded so it can't
// partial-match inside a longer alphanumeric group elsewhere in the report.
const WIND_GROUP_RE = /\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/

/** Returns null if the raw text has no recognisable wind group — callers should just omit
 *  the formatted line in that case rather than showing something misleading. */
export function parseWindGroup(rawText: string): ParsedWind | null {
  const match = WIND_GROUP_RE.exec(rawText)
  if (!match) return null
  const [, dir, speed, gust, unit] = match
  return {
    directionDeg: dir === 'VRB' ? null : Number(dir),
    isVariable: dir === 'VRB',
    speedValue: Number(speed),
    gustValue: gust ? Number(gust) : null,
    sourceUnit: unit === 'MPS' ? 'mps' : 'kt'
  }
}

const KT_PER_MPS = 1 / 0.514444

function convertSpeed(value: number, from: WindSpeedUnit, to: WindSpeedUnit): number {
  if (from === to) return value
  return Math.round(from === 'kt' ? value / KT_PER_MPS : value * KT_PER_MPS)
}

const UNIT_LABEL: Record<WindSpeedUnit, string> = { kt: 'kt', mps: 'm/s' }

/** A short, human-readable line — never a replacement for the raw METAR text, which
 *  should always stay visible alongside this. */
export function formatWind(wind: ParsedWind, displayUnit: WindSpeedUnit): string {
  const label = UNIT_LABEL[displayUnit]
  const dirText = wind.isVariable ? 'Variable' : `${String(wind.directionDeg).padStart(3, '0')}°`
  const speed = convertSpeed(wind.speedValue, wind.sourceUnit, displayUnit)
  const speedText =
    wind.gustValue != null
      ? `${speed} ${label}, gusting ${convertSpeed(wind.gustValue, wind.sourceUnit, displayUnit)} ${label}`
      : `${speed} ${label}`
  return `Wind ${dirText} at ${speedText}`
}
