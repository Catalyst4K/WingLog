import type { MaintenanceAddon } from '@shared/ipc'

/** Which maintenance-data adapter (if any) applies to a given aircraft, from its own
 *  `icaoType` — real Boeing 777 (B772/B773/B77L/B77W/…) and Airbus A350 (A359/A35K/…) type
 *  codes, not an add-on-specific product list. Real bug this exists to prevent
 *  (flightdeck-backend's docs/plans/fleet-maintenance.md): both PMDG's and iniBuilds' own
 *  WASM folders can independently have a file for the same real-world registration (e.g.
 *  B-LRJ, a real Cathay Pacific tail both add-ons ship a sample/default livery for) —
 *  picking the adapter by "which file happens to exist" silently showed PMDG 777 data on an
 *  aircraft WingLog's own fleet already knows is an A350. The ICAO family prefix is a fact
 *  about the real airframe, not add-on catalog knowledge that could go stale, so this is a
 *  narrower and more durable check than a hardcoded list of supported liveries would be. */
export function resolveMaintenanceAddon(icaoType: string): MaintenanceAddon | null {
  const upper = icaoType.toUpperCase()
  if (upper.startsWith('B77')) return 'pmdg777'
  if (upper.startsWith('A35')) return 'inibuildsA350'
  return null
}
