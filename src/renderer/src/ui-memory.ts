/**
 * The renderer's one store for screen state that must survive a component unmounting: leaving the
 * Track tab and coming back keeps the map's camera, its toggles and the taxi clearance as the
 * pilot left them (winglog-backend docs/coding-standards.md §4). In-session only, never saved.
 * Values are read when a component mounts and written as they change; nothing subscribes.
 */
import type { Airfield, NavdataTaxiSegment } from '@shared/ipc'
import { INITIAL_TAXI_MEMORY, type TaxiMemory } from './taxi-clearance-step'

/** Everything remembered between mounts. */
export interface UiMemory {
  /** The live map's last camera, so returning to Track doesn't reset the view. */
  liveCamera: { center: [number, number]; zoom: number } | null
  /** Which planned route liveCamera was framed for: the route is re-fitted only when it changes. */
  liveCameraRouteKey: string | null
  /** Whether liveCamera's zoom was the user's choice (kept when follow mode frames the aircraft). */
  liveZoomChosenByUser: boolean
  /** "Center on aircraft". */
  followEnabled: boolean
  /** The taxi chart overlay's toggle. */
  taxiChartEnabled: boolean
  /** Taxi networks already loaded, by ICAO, so switching airports or tabs doesn't re-fetch. */
  taxiSegments: Map<string, NavdataTaxiSegment[]>
  /** Plans and airports whose approach the pilot cleared with "None" in the Procedures dialog,
   *  so the auto-default doesn't put one straight back when the dialog reopens. */
  approachCleared: Set<string>
  /** The VFR overlay's toggle. */
  vfrEnabled: boolean
  /** The airfield list, fetched once (~43k rows), so it isn't sent over IPC again. */
  vfrAirfields: Airfield[] | null
  /** The taxi line's clearance and what's been read, so a remount doesn't re-take old ones. */
  taxiRoute: TaxiMemory
}

function initial(): UiMemory {
  return {
    liveCamera: null,
    liveCameraRouteKey: null,
    liveZoomChosenByUser: false,
    followEnabled: true,
    taxiChartEnabled: false,
    taxiSegments: new Map(),
    approachCleared: new Set(),
    vfrEnabled: false,
    vfrAirfields: null,
    taxiRoute: { ...INITIAL_TAXI_MEMORY }
  }
}

const memory: UiMemory = initial()

/**
 * The store.
 *
 * @returns The one UiMemory, read and written in place.
 */
export function uiMemory(): UiMemory {
  return memory
}

/** Forgets everything, as at app start. For tests. */
export function resetUiMemory(): void {
  Object.assign(memory, initial())
}
