import type { GsxRemoteGateInfo, GsxRemoteServiceStatus } from '@shared/ipc'

/**
 * Services shown only while active, otherwise folded under "show more" — Callum's call
 * (2026-09-21): the core turnaround services (boarding/deboarding, catering, refuel,
 * pushback, jetway) stay visible always, the rest (stairs, GPU, de-ice, lavatory, water,
 * cleaning) only matter when actually in use. Ids are GSX's own wire ids, confirmed live
 * (flightdeck-backend's docs/gsx-notes.md, round 6/7 captures — the full real
 * `state.services` id list for a VHHH session).
 */
const SECONDARY_SERVICE_IDS = new Set(['OperateStairs', 'GPU', 'DeIce', 'Lavatory', 'Water', 'Cleaning'])

/** GSX's own `state` values — 'available' means idle/not requested; anything else (
 *  'requested', 'performing', 'bypassed', …) means the service is actually in play. */
export function isServiceActive(service: GsxRemoteServiceStatus): boolean {
  return service.state !== 'available'
}

export function isSecondaryService(service: GsxRemoteServiceStatus): boolean {
  return SECONDARY_SERVICE_IDS.has(service.id)
}

/** Services that should always render, in order: every primary service, plus any secondary
 *  one currently active. */
export function visibleServices(services: GsxRemoteServiceStatus[]): GsxRemoteServiceStatus[] {
  return services.filter((s) => !isSecondaryService(s) || isServiceActive(s))
}

/** Secondary services currently idle — folded away behind a "show more" toggle rather than
 *  cluttering the always-visible list. */
export function hiddenServices(services: GsxRemoteServiceStatus[]): GsxRemoteServiceStatus[] {
  return services.filter((s) => isSecondaryService(s) && !isServiceActive(s))
}

/** GSX's own `detail.bill` (and the wider `state.billing`) are already USD-equivalent —
 *  confirmed live 2026-09-21 (docs/gsx-notes.md): a real Refueling `detail.bill: 24272`
 *  matched "Bill $24272" verbatim in the same message's `statusText`, with no decimals shown.
 *  Mirrored here rather than reformatted with cents GSX itself never displays. */
export function formatGsxBill(amountUsd: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(amountUsd)
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString()
}

/** `detail.fuel.current`/`target` as a nicely separated "15,357 / 81,488 kg" instead of
 *  re-parsing it out of `statusText`'s free text — real shape confirmed live 2026-09-21
 *  (docs/gsx-notes.md, round 6 capture). */
export function formatFuelProgress(fuel: { current: number; target: number; unit: string }): string {
  return `${formatNumber(fuel.current)} / ${formatNumber(fuel.target)} ${fuel.unit}`
}

/** `detail.pax.done`/`total` as "0 / 344" — real shape confirmed live 2026-09-21
 *  (docs/gsx-notes.md, round 7 capture, a real Boarding session). */
export function formatPaxProgress(pax: { done: number; total: number }): string {
  return `${formatNumber(pax.done)} / ${formatNumber(pax.total)}`
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1)
}

/** One cargo hold's progress as "Front: 0 / 7 ULDs" — `hold` is GSX's own lowercase free
 *  text ("front"/"rear"), capitalized for display only, never matched against a fixed set. */
export function formatCargoProgress(cargo: { hold: string; done: number; total: number; unit: string }): string {
  return `${capitalize(cargo.hold)}: ${formatNumber(cargo.done)} / ${formatNumber(cargo.total)} ${cargo.unit}`
}

/**
 * GSX's `state.parking` is one string, area and gate joined by a single "|" — real shape
 * confirmed live 2026-09-21 (docs/gsx-notes.md, round 6 capture): `"(N) T1 North|Gate N6"`.
 * Split defensively: a parking string with no "|" (a simpler airport/profile) just becomes
 * the gate label with no area line, rather than assuming the "|" is always present.
 */
export function parseGsxParking(parking: string): { gateLabel: string; area: string | null } {
  const parts = parking
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (parts.length === 0) return { gateLabel: parking.trim(), area: null }
  if (parts.length === 1) return { gateLabel: parts[0], area: null }
  return { gateLabel: parts[1], area: parts[0] }
}

/** Nothing to reformat here beyond the parking split above — exported together so
 *  GsxRemotePanel has one place to import gate-related formatting from. */
export function gateSubtitle(gate: GsxRemoteGateInfo, area: string | null): string {
  return [gate.airportIcao, gate.airportName, area].filter((p): p is string => Boolean(p)).join(' · ')
}
