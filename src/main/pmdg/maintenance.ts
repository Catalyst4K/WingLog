import type { MaintenanceField, MaintenanceGroup, MaintenanceReport } from '@shared/ipc'
import { parseIniSections } from '../wasm-maintenance/ini-sections'

/** Reads a numeric key and formats it as a plain string, or returns null if it's missing or
 *  not a finite number — never NaN/undefined shown to the user (CLAUDE.md: parse external
 *  data defensively). No unit is appended: the spike that catalogued these fields
 *  (flightdeck-backend docs/wasm-maintenance-notes.md) didn't confirm real-world units or
 *  scale for any of them, so showing an invented unit would be worse than showing none. */
function numericField(section: Record<string, string>, rawKey: string): string | null {
  const raw = section[rawKey]
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? String(n) : null
}

function extractEngineFields(section: Record<string, string>): MaintenanceField[] {
  const fields: MaintenanceField[] = []
  for (const [engineIndex, rawKey] of [
    [1, 'OilQ_Last.0'],
    [2, 'OilQ_Last.1']
  ] as const) {
    const value = numericField(section, rawKey)
    if (value !== null) fields.push({ key: 'oilQuantity', index: engineIndex, value })
  }
  return fields
}

/** Only the `Assy State` sub-field per wheel position is surfaced — the other four
 *  (`Assy LE`/`Assy BE`/`Assy TM`/`Press TM`) exist in the real file but their real-world
 *  meaning wasn't confirmed by the spike, and showing all five per wheel (~60 rows across 12
 *  main + 2 nose positions) would be an unreadable dump rather than a useful summary. */
function extractWheelFields(section: Record<string, string>): MaintenanceField[] {
  const fields: MaintenanceField[] = []
  for (let i = 0; i < 12; i++) {
    const value = numericField(section, `Wheel Assy State.${i}`)
    if (value !== null) fields.push({ key: 'wheelMain', index: i + 1, value })
  }
  for (let i = 0; i < 2; i++) {
    const value = numericField(section, `Nose Wheel Assy State.${i}`)
    if (value !== null) fields.push({ key: 'wheelNose', index: i + 1, value })
  }
  return fields
}

function extractHydraulicsFields(section: Record<string, string>): MaintenanceField[] {
  const fields: MaintenanceField[] = []
  for (let i = 0; i < 3; i++) {
    const volume = numericField(section, `Volume Sys.${i}`)
    if (volume !== null) fields.push({ key: 'hydraulicsVolume', index: i + 1, value: volume })
    const temp = numericField(section, `Temp Sys.${i}`)
    if (temp !== null) fields.push({ key: 'hydraulicsTemp', index: i + 1, value: temp })
  }
  return fields
}

function extractFuelFields(section: Record<string, string>): MaintenanceField[] {
  const fields: MaintenanceField[] = []
  for (let i = 0; i < 4; i++) {
    const volume = numericField(section, `Tank ${i} Volume`)
    if (volume !== null) fields.push({ key: 'fuelVolume', index: i + 1, value: volume })
    const temp = numericField(section, `Tank ${i} Temperature`)
    if (temp !== null) fields.push({ key: 'fuelTemperature', index: i + 1, value: temp })
  }
  return fields
}

/** Which `.hours` sections are surfaced at all, and how. An allow-list, not a blocklist —
 *  `[Failure Groups]`/`[Failure Items]` (PMDG's random-failure system, not maintenance state)
 *  are excluded simply by not being in this list, same as any other unrecognized section. */
const FIELD_SPECS: {
  groupKey: MaintenanceGroup['key']
  sectionName: string
  extract: (section: Record<string, string>) => MaintenanceField[]
}[] = [
  { groupKey: 'engines', sectionName: 'Engines', extract: extractEngineFields },
  { groupKey: 'wheels', sectionName: 'Wheels', extract: extractWheelFields },
  { groupKey: 'hydraulics', sectionName: 'Hydraulics', extract: extractHydraulicsFields },
  { groupKey: 'fuel', sectionName: 'Fuel', extract: extractFuelFields }
]

/** Builds a MaintenanceReport from a real (or synthetic-fixture) `.hours` file's text.
 *  Never throws — an unparsable or empty file (one real sampled tail's `.hours` was pure
 *  whitespace) yields `{ addon: 'pmdg777', groups: [] }`, not an error. */
export function buildMaintenanceReport(text: string): MaintenanceReport {
  const sections = parseIniSections(text)
  const groups: MaintenanceGroup[] = []
  for (const spec of FIELD_SPECS) {
    const section = sections.get(spec.sectionName)
    if (!section) continue
    const fields = spec.extract(section)
    if (fields.length > 0) groups.push({ key: spec.groupKey, fields })
  }
  return { addon: 'pmdg777', groups }
}
