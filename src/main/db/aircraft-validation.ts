import type { NewAircraft } from '@shared/ipc'

const REQUIRED_STRING_FIELDS = ['registration', 'icaoType'] as const
const OPTIONAL_STRING_FIELDS = [
  'operator',
  'operatorIata',
  'operatorIcao',
  'simbriefAirframeId',
  'simbriefType',
  'simbriefAirframeDeveloper',
  'simbriefAirframeEngines',
  'simbriefAirframeRegistration',
  'currentIcao',
  'photoThumbnailUrl'
] as const

export type AircraftInputResult = { data: NewAircraft } | { error: string }

/**
 * Validates and normalizes aircraft input from an untrusted source (an imported JSON
 * file, and defensively for IPC from the renderer) into a well-typed NewAircraft. Shared
 * by create, update and bulk import so all three enforce the same rules.
 */
export function parseAircraftInput(raw: unknown): AircraftInputResult {
  if (typeof raw !== 'object' || raw === null) return { error: 'Expected an object' }
  const input = raw as Record<string, unknown>
  const fields: Record<string, unknown> = {}

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = input[field]
    if (typeof value !== 'string' || value.trim() === '') return { error: `"${field}" is required` }
    fields[field] = value.trim()
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = input[field]
    // Genuinely absent (an older import file that never had this key) — leave it alone,
    // don't touch whatever the row already has. A present-but-blank value (null or '') is
    // different: it's the caller explicitly clearing the field, so it must become a real
    // `null` here — not skipped — or an update's `.set()` never includes the column at
    // all and silently leaves the previous value in place (confirmed live, docs/plans/
    // simbrief-airframe-picker.md: switching a fleet aircraft off a custom SimBrief
    // airframe back to blank had no effect until this distinction was added).
    if (value === undefined) continue
    if (value === null || value === '') {
      fields[field] = null
      continue
    }
    if (typeof value !== 'string') return { error: `"${field}" must be a string` }
    fields[field] = value.trim()
  }

  // Every field above was validated against NewAircraft's exact shape; a single cast
  // here (rather than one per field) keeps the validation loops readable.
  return { data: fields as unknown as NewAircraft }
}
