/**
 * The one validator for aircraft input, used by create, update and import alike.
 */
import type { NewAircraft } from '@shared/ipc'
import { t } from '../i18n'

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
 *
 * @param raw Anything: an imported record or the renderer's input.
 * @returns The aircraft, trimmed and typed, or the first error found.
 */
export function parseAircraftInput(raw: unknown): AircraftInputResult {
  if (typeof raw !== 'object' || raw === null) return { error: t('errors.expectedAnObject') }
  const input = raw as Record<string, unknown>
  const required = { registration: '', icaoType: '' }
  const fields: Partial<Record<(typeof OPTIONAL_STRING_FIELDS)[number], string | null>> = {}

  for (const field of REQUIRED_STRING_FIELDS) {
    const value = input[field]
    if (typeof value !== 'string' || value.trim() === '') return { error: t('errors.fieldRequired', { field }) }
    required[field] = value.trim()
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
    if (typeof value !== 'string') return { error: t('errors.fieldMustBeString', { field }) }
    fields[field] = value.trim()
  }

  return { data: { ...required, ...fields } }
}
