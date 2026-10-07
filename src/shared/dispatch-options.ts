/**
 * Dispatch's "Advanced…" options — pax/cargo/fuel/weights, cost index, and a handful of
 * other SimBrief generation parameters worth exposing beyond origin/destination/airframe.
 * Pure, no React, deliberately — this is where the real risk of the whole feature lives
 * (docs/decisions.md, dispatch-advanced-tab entry), so it's unit-testable without
 * rendering anything. Lives in src/shared rather than src/renderer (moved 2026-09-04) so
 * main-process tests can build a real generation URL from the same field set the Advanced
 * dialog actually produces, rather than a hand-picked subset.
 *
 * Every field is `string | 'auto' | null` rather than a number: SimBrief represents
 * "let SimBrief decide" as the literal string `"auto"` for several fields (pax, manualzfw,
 * manualpayload, contpct, resvrule, cruisesub) — a distinct state from both an unset field
 * (don't send the parameter at all) and a real `0`. Collapsing any of the three into
 * another would silently change what gets generated.
 */

export type OptionValue = string | 'auto' | null

export interface DispatchOptions {
  // Load
  pax: OptionValue
  cargo: OptionValue
  manualzfw: OptionValue
  manualpayload: OptionValue
  // Fuel
  fuelfactor: OptionValue
  addedfuel: OptionValue
  contpct: OptionValue
  resvrule: OptionValue
  taxiout: OptionValue
  taxiin: OptionValue
  tankering: OptionValue
  // Cruise
  civalue: OptionValue
  cruisemode: OptionValue
  cruisesub: OptionValue
  fl: OptionValue
  climb: OptionValue
  descent: OptionValue
  // Route
  route: OptionValue
  origrwy: OptionValue
  destrwy: OptionValue
}

/** The field's own name doubles as SimBrief's *input* parameter name throughout this
 *  module — keeping them identical is what makes toUrlParams a trivial pass-through and
 *  avoids a second name mapping to keep in sync. */
const FIELDS = [
  'pax',
  'cargo',
  'manualzfw',
  'manualpayload',
  'fuelfactor',
  'addedfuel',
  'contpct',
  'resvrule',
  'taxiout',
  'taxiin',
  'tankering',
  'civalue',
  'cruisemode',
  'cruisesub',
  'fl',
  'climb',
  'descent',
  'route',
  'origrwy',
  'destrwy'
] as const satisfies readonly (keyof DispatchOptions)[]

/**
 * @returns Options with every field unset, which reproduces SimBrief's own defaults.
 */
export function defaultDispatchOptions(): DispatchOptions {
  const options = {} as DispatchOptions
  for (const field of FIELDS) options[field] = null
  return options
}

/**
 * How many fields are actually set — drives the "Advanced (3)" button label, so a
 * cost index left over from a previous flight is never silently in effect with nothing
 * on screen saying so.
 *
 * @param options The dispatch options.
 * @returns The number of fields set.
 */
export function countSetOptions(options: DispatchOptions): number {
  return FIELDS.filter((field) => options[field] !== null).length
}

/**
 * Pure, returns only the parameters that are actually set — an all-default
 * DispatchOptions produces an empty array, so leaving every advanced field untouched
 * reproduces exactly today's URL.
 *
 * @param options The dispatch options.
 * @returns The set fields as URL parameter pairs.
 */
export function dispatchOptionsToUrlParams(options: DispatchOptions): [string, string][] {
  const params: [string, string][] = []
  for (const field of FIELDS) {
    const value = options[field]
    if (value !== null) params.push([field, value])
  }
  return params
}

/**
 * SimBrief's `api_params` echo uses different names and units than its own input
 * parameters for a few fields (docs/simbrief-notes.md) — confirmed mismatches, all
 * deliberately NOT read here because they're either out of this branch's four groups
 * (`notams`/`notams_opt`, `units`/`pounds`) or need a different source entirely
 * (`civalue`, see below). Every field this module cares about besides `civalue` is
 * echoed under its own input name unchanged.
 *
 * @param value One echoed value.
 * @returns The option value, or null for an empty or missing one.
 */
function fromEchoed(value: unknown): OptionValue {
  if (value === 'auto') return 'auto'
  if (typeof value === 'string' && value !== '') return value
  return null
}

/**
 * Translates a stored flight's raw OFP JSON into a DispatchOptions the advanced dialog
 * can be pre-filled from — "Load settings from a previous flight". Returns null when the
 * JSON has no `api_params` section (a flight stored before this feature existed) or isn't
 * parseable JSON at all, per the same "return empty/null on anything unexpected"
 * precedent route.ts already sets for stored OFP JSON.
 *
 * `civalue` is a deliberate exception to "read api_params under its own name": the cost
 * index *value* isn't echoed in api_params at all (only `cruisemode`/`cruisesub`, which
 * say *how* CI is being used, not what it is) — the actual number lives in
 * `general.costindex` instead (docs/simbrief-notes.md).
 *
 * @param ofpJson A stored flight's raw OFP JSON.
 * @returns The options it was planned with, or null.
 */
export function dispatchOptionsFromApiParams(ofpJson: string): DispatchOptions | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(ofpJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const root = parsed as Record<string, unknown>
  const apiParams = root.api_params
  if (typeof apiParams !== 'object' || apiParams === null) return null
  const params = apiParams as Record<string, unknown>
  const general =
    typeof root.general === 'object' && root.general !== null ? (root.general as Record<string, unknown>) : {}

  const options = defaultDispatchOptions()
  for (const field of FIELDS) {
    if (field === 'civalue') continue
    options[field] = fromEchoed(params[field])
  }
  options.civalue = fromEchoed(general.costindex)
  return options
}
