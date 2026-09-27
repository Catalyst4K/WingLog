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

function extractApuFields(section: Record<string, string>): MaintenanceField[] {
  const fields: MaintenanceField[] = []
  const hours = numericField(section, 'apu_hours')
  if (hours !== null) fields.push({ key: 'apuHours', value: hours })
  const oil = numericField(section, 'apu_oil')
  if (oil !== null) fields.push({ key: 'apuOilQuantity', value: oil })
  const cycles = numericField(section, 'apu_start_cycles')
  if (cycles !== null) fields.push({ key: 'apuStartCycles', value: cycles })
  return fields
}

/** All four batteries confirmed present in every real sampled file — no reason to be as
 *  conservative here as PMDG's wheel fields (this section is small and complete, not a
 *  per-position explosion). */
function extractElectricalFields(section: Record<string, string>): MaintenanceField[] {
  const fields: MaintenanceField[] = []
  for (const [index, rawKey] of [
    [1, 'battery_1_pct'],
    [2, 'battery_2_pct']
  ] as const) {
    const value = numericField(section, rawKey)
    if (value !== null) fields.push({ key: 'batteryPct', index, value })
  }
  for (const [index, rawKey] of [
    [1, 'battery_emer1_pct'],
    [2, 'battery_emer2_pct']
  ] as const) {
    const value = numericField(section, rawKey)
    if (value !== null) fields.push({ key: 'batteryEmergencyPct', index, value })
  }
  return fields
}

function extractEngineFields(section: Record<string, string>): MaintenanceField[] {
  const fields: MaintenanceField[] = []
  for (const [index, hoursKey, oilKey] of [
    [1, 'eng1_hours', 'eng1_oil_level'],
    [2, 'eng2_hours', 'eng2_oil_level']
  ] as const) {
    const hours = numericField(section, hoursKey)
    if (hours !== null) fields.push({ key: 'engineHours', index, value: hours })
    const oil = numericField(section, oilKey)
    if (oil !== null) fields.push({ key: 'oilQuantity', index, value: oil })
  }
  return fields
}

function extractHydraulicsFields(section: Record<string, string>): MaintenanceField[] {
  const fields: MaintenanceField[] = []
  for (const [index, rawKey] of [
    [1, 'hyd1_rsv'],
    [2, 'hyd2_rsv']
  ] as const) {
    const value = numericField(section, rawKey)
    if (value !== null) fields.push({ key: 'hydraulicsReservoir', index, value })
  }
  return fields
}

/** Which `.data` sections are surfaced, and how — an allow-list, matching the shape confirmed
 *  across all 5 real sampled files (docs/wasm-maintenance-notes.md, flightdeck-backend):
 *  `[apu]`, `[elec]`, `[eng]`, `[hyd]`, lowercase, unlike PMDG's `.hours` file. */
const FIELD_SPECS: {
  groupKey: MaintenanceGroup['key']
  sectionName: string
  extract: (section: Record<string, string>) => MaintenanceField[]
}[] = [
  { groupKey: 'apu', sectionName: 'apu', extract: extractApuFields },
  { groupKey: 'electrical', sectionName: 'elec', extract: extractElectricalFields },
  { groupKey: 'engines', sectionName: 'eng', extract: extractEngineFields },
  { groupKey: 'hydraulics', sectionName: 'hyd', extract: extractHydraulicsFields }
]

/** Builds a MaintenanceReport from a real (or synthetic-fixture) `.data` file's text. Never
 *  throws — an unparsable or empty file yields `{ addon: 'inibuildsA350', groups: [] }`, not
 *  an error. */
export function buildMaintenanceReport(text: string): MaintenanceReport {
  const sections = parseIniSections(text)
  const groups: MaintenanceGroup[] = []
  for (const spec of FIELD_SPECS) {
    const section = sections.get(spec.sectionName)
    if (!section) continue
    const fields = spec.extract(section)
    if (fields.length > 0) groups.push({ key: spec.groupKey, fields })
  }
  return { addon: 'inibuildsA350', groups }
}
