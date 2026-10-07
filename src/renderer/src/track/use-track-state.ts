/**
 * The Track tab's state: the flights and the one being tracked, the free-flight banner, and the
 * ET / time remaining / ETA readouts. TrackView calls these in this order.
 */

import { winglogApi } from '../data/winglog-api'
import { useEffect, useRef, useState } from 'react'
import type { ActiveTracking, Aircraft, Flight, SimTelemetry, TrackPoint } from '@shared/ipc'
import { flightLabel } from '../flight-label'
import { runAsync } from '../report-error'
import { computeTrackTimes, type TrackTimes } from '../track-times'
import { realIcao } from '../display-icao'

// Display-only duplicate of FlightRecorder's own MOVING_MS (~1kt) — the renderer can't
// import main-process code (this repo's own layout rule), and this threshold only decides
// whether to *show a prompt*, never anything persisted, so a second small constant here is
// cheaper than a round trip for it.
const GROUND_MOVEMENT_THRESHOLD_MS = 0.5

// Raised from 3 to match AutoStartDetector's own proven bar (8 consecutive 1Hz samples) for
// the analogous "is this real or reload garbage" problem — a reasonable tightening, not a
// confirmed fix: AutoStartDetector's 8-sample number is proven against a *flight-to-flight*
// reload specifically (docs/decisions.md, 2026-09-02), not "sitting at the main menu before
// anything is loaded," which hasn't actually been captured. If a false trigger still shows
// up before a flight is loaded, the next step is a throwaway capture script through that
// specific transition (same shape as the old spike-capture-flight.ts/spike-flight-reload.ts
// precedent), not a third guess at the sample count.
const BANNER_SUSTAIN_SAMPLES = 8

/** The fleet, the flights, and the one being tracked with its recorded track. */
export interface TrackedFlights {
  aircraft: Aircraft[]
  flights: Flight[]
  active: ActiveTracking | null
  setActive: (active: ActiveTracking | null) => void
  trackPoints: TrackPoint[]
  setTrackPoints: (points: TrackPoint[]) => void
  /** Until the active flight's recorded track has loaded, the map holds off framing the
   *  route (FlightMap's trackLoading). */
  trackLoading: boolean
  /** Set when a flight completes on its own (shutdown detected): the "flight ended" dialog. */
  completedLabel: string | null
  setCompletedLabel: (label: string | null) => void
  reload: () => Promise<void>
}

/**
 * Loads the fleet, the flights and the active flight's track, then follows tracking live.
 *
 * @param onFlightEnded Called when a flight completes on its own.
 * @returns The flights and the tracked one.
 */
export function useTrackedFlights(onFlightEnded: (() => void) | undefined): TrackedFlights {
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [flights, setFlights] = useState<Flight[]>([])
  const [active, setActive] = useState<ActiveTracking | null>(null)
  const [trackPoints, setTrackPoints] = useState<TrackPoint[]>([])
  const [trackLoading, setTrackLoading] = useState(true)
  const [completedLabel, setCompletedLabel] = useState<string | null>(null)
  // The onTrackingPoint listener below is registered once on mount, so it closes over
  // whatever `flights`/`onFlightEnded` were at that time — refs kept in step with the real
  // values let it use both without going stale.
  const flightsRef = useRef<Flight[]>([])
  const onFlightEndedRef = useRef(onFlightEnded)

  function reload(): Promise<void> {
    return Promise.all([winglogApi().aircraftList(), winglogApi().flightList()]).then(
      ([aircraftList, flightList]) => {
        setAircraft(aircraftList)
        setFlights(flightList)
      }
    )
  }

  useEffect(() => {
    flightsRef.current = flights
  }, [flights])

  useEffect(() => {
    onFlightEndedRef.current = onFlightEnded
  }, [onFlightEnded])

  useEffect(() => {
    runAsync('TrackView reload', reload())
    runAsync(
      'TrackView trackPointList',
      winglogApi()
        .trackingGetActive()
        .then(async (a) => {
          setActive(a)
          if (a) setTrackPoints(await winglogApi().trackPointList(a.flightId))
        })
        .finally(() => setTrackLoading(false))
    )
    const unsubscribe = winglogApi().onTrackingPoint((point) => {
      if (point.phase === 'shutdown') {
        // Auto-completed (as opposed to a manual "Finish & save") — clear the banner and
        // the map's trail immediately rather than leaving them showing a flight the
        // backend already completed. Matters most for a turnaround: staying on this page
        // between legs means there's no page remount to accidentally paper over it.
        const completed = flightsRef.current.find((f) => f.id === point.flightId)
        setCompletedLabel(flightLabel(completed))
        setActive(null)
        setTrackPoints([])
        runAsync('TrackView reload', reload())
        onFlightEndedRef.current?.()
        return
      }
      setTrackPoints((current) =>
        current.length && current[0].flightId !== point.flightId ? [point] : [...current, point]
      )
      setActive({ flightId: point.flightId, phase: point.phase })
    })
    // A resume-cleanup pass (winglog-backend's docs/plans/done/resume-track-cleanup.md) can
    // flag a point as junk or retag its resumeSegment after it's already been pushed above
    // and drawn — patch each affected point in place by id rather than waiting for a
    // reload, so the trail corrects itself live instead of only once the flight completes.
    const unsubscribeUpdated = winglogApi().onTrackingPointsUpdated((updated) => {
      if (updated.length === 0) return
      setTrackPoints((current) => {
        const byId = new Map(updated.map((p) => [p.id, p]))
        return current.map((p) => byId.get(p.id) ?? p)
      })
    })
    return () => {
      unsubscribe()
      unsubscribeUpdated()
    }
  }, [])

  return {
    aircraft,
    flights,
    active,
    setActive,
    trackPoints,
    setTrackPoints,
    trackLoading,
    completedLabel,
    setCompletedLabel,
    reload
  }
}

/** Whether the passive free-flight banner shows, and its dismissal. */
export interface FreeFlightBanner {
  show: boolean
  dismissed: boolean
  dismiss: () => void
}

/**
 * The passive detection banner (free-flight-tracking.md): sim connected, nothing being
 * tracked, and the aircraft is either moving on the ground or airborne for several
 * consecutive samples running — never fires just because the sim is loaded and parked.
 *
 * @param telemetry The live telemetry, if any.
 * @param suppressed True while a flight is tracked or a planned one is loaded: that flight's
 *   own card offers "Start tracking", and the banner's button would start a second, unrelated
 *   free flight.
 * @returns The banner's state.
 */
export function useFreeFlightBanner(
  telemetry: SimTelemetry | null | undefined,
  suppressed: boolean
): FreeFlightBanner {
  // Reset per-episode, not per app session (free-flight-tracking.md's open question #1 is
  // explicit that the exact banner-annoyance tradeoff is still undecided) — cleared the
  // moment the trigger condition itself goes false, so a later, genuinely new stretch of
  // flying prompts again rather than staying silenced forever.
  const [dismissed, setDismissed] = useState(false)

  // Raw per-sample trigger — moving on the ground or airborne. Not used directly: a single
  // sample of this can't be trusted on its own. Callum saw this live (2026-09-16, sitting at
  // MSFS's World Map with no flight loaded at all) — WingLog briefly showed the aircraft as
  // airborne, then it corrected itself a moment later. AutoStartDetector already documents
  // this same family of transient garbage for the on-the-ground case (a reload's telemetry
  // "looks plausible but isn't" for the better part of a minute) and requires several
  // consecutive stable samples before trusting it; this banner had no equivalent guard. See
  // docs/simconnect-notes.md, 2026-09-16.
  const rawTrigger =
    !!telemetry && (!telemetry.onGround || telemetry.groundSpeedMs > GROUND_MOVEMENT_THRESHOLD_MS)
  // Counts consecutive samples agreeing with rawTrigger, adjusted during render (same pattern
  // as prevShow below) keyed on telemetry object identity — a fresh reference arrives with
  // every push, so this reliably detects "a new sample arrived" without a useEffect.
  const [prevTelemetry, setPrevTelemetry] = useState(telemetry)
  const [sustainedCount, setSustainedCount] = useState(rawTrigger ? 1 : 0)
  if (telemetry !== prevTelemetry) {
    // `title` changing is a new episode — confirmed (docs/decisions.md, 2026-09-02) as the
    // one signal that changes instantly and reliably across a reload, unlike position/
    // altitude/onGround, which can hold a stale, plausible-looking value for the better part
    // of a minute. Restarting the sustain count from scratch here, rather than trusting
    // whatever count a *different* aircraft's telemetry had already built toward the
    // threshold, also fixes a real bug: a false pre-load trigger that blends straight into a
    // real one (both satisfying rawTrigger, with no false moment in between) used to mean
    // `dismissed` — set from dismissing the false alarm — silently suppressed the real,
    // later episode too, since the show-goes-false reset below never fired.
    const titleChanged = (prevTelemetry?.title ?? null) !== (telemetry?.title ?? null)
    setPrevTelemetry(telemetry)
    setSustainedCount(rawTrigger ? (titleChanged ? 1 : sustainedCount + 1) : 0)
    if (titleChanged) setDismissed(false)
  }

  const show = !suppressed && sustainedCount >= BANNER_SUSTAIN_SAMPLES
  // Resets the dismissal the moment the trigger condition itself goes false (parked again,
  // or tracking started) — adjusted during render, React's own documented pattern for state
  // that depends on another value changing, same as AircraftForm.tsx's own
  // committedIcaoTypeForOptions.
  const [prevShow, setPrevShow] = useState(show)
  if (show !== prevShow) {
    setPrevShow(show)
    if (!show) setDismissed(false)
  }
  return { show, dismissed, dismiss: () => setDismissed(true) }
}

/**
 * ET / time remaining / ETA (winglog-backend's docs/plans/track-time-readouts.md). A free
 * flight has no planned route, so its great-circle line stands in (the Logbook's own).
 *
 * @param args The tracked flight, its route and track, and the live telemetry.
 * @returns The readouts.
 */
export function useTrackTimes(args: {
  active: ActiveTracking | null
  activeFlight: Flight | undefined
  route: [number, number][]
  trackPoints: TrackPoint[]
  telemetry: SimTelemetry | null | undefined
}): TrackTimes {
  const { active, activeFlight, route, trackPoints, telemetry } = args
  const freeFlightAirports = freeFlightRouteKey(activeFlight)
  const [greatCircle, setGreatCircle] = useState<{ key: string; route: [number, number][] } | null>(null)
  useEffect(() => {
    if (!freeFlightAirports) return
    let ignore = false
    const [dep, arr] = freeFlightAirports.split('-') as [string, string]
    // No great circle (an airport not in the list): the readouts just show no estimate.
    winglogApi().logbookGreatCircleRoute(dep, arr).then(
      (gc) => {
        if (!ignore) setGreatCircle({ key: freeFlightAirports, route: gc ?? [] })
      },
      () => undefined
    )
    return () => {
      ignore = true
    }
  }, [freeFlightAirports])
  // ET has to tick on its own — telemetry stops arriving while the sim is paused.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const timesRoute =
    route.length >= 2 ? route : greatCircle?.key === freeFlightAirports ? greatCircle.route : []
  return liveTrackTimes({ route: timesRoute, trackPoints, activeFlight, telemetry, now })
}

/**
 * @param flight The tracked flight, if any.
 * @returns "DEP-ARR" for a free flight between two real airports (its route is then the great
 *   circle), else null.
 */
function freeFlightRouteKey(flight: Flight | undefined): string | null {
  return flight && !flight.ofpJson && realIcao(flight.depIcao) && realIcao(flight.arrIcao)
    ? `${flight.depIcao}-${flight.arrIcao}`
    : null
}

/**
 * The readouts for this moment.
 *
 * @param args The route to measure along, the track, the flight, the telemetry and the time now.
 * @returns ET, time remaining and ETA.
 */
function liveTrackTimes(args: {
  route: [number, number][]
  trackPoints: TrackPoint[]
  activeFlight: Flight | undefined
  telemetry: SimTelemetry | null | undefined
  now: number
}): TrackTimes {
  const { trackPoints, activeFlight, telemetry } = args
  // The live track knows takeoff before the flight list is reloaded.
  const takeoffUtc = trackPoints.find((p) => !p.onGround)?.tsUtc ?? activeFlight?.actualOffUtc ?? null
  return computeTrackTimes({
    route: args.route,
    position: telemetry ? { lat: telemetry.latitude, lon: telemetry.longitude } : null,
    groundSpeedMs: telemetry?.groundSpeedMs ?? null,
    onGround: telemetry?.onGround ?? true,
    takeoffUtc,
    schedInUtc: activeFlight?.schedInUtc ?? null,
    now: args.now
  })
}
