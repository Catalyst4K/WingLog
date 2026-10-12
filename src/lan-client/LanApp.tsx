/** The second-screen page: pair with the PC once, then the live map of the flight being tracked. */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiveTopic, LiveTopics } from '@shared/live'
import type { LanFlight, LanFlightSnapshot, ProcedureSelection, SimTelemetry, TrackPoint } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { FlightMap } from '@/FlightMap'
import { realIcao } from '@/display-icao'
import type { Waypoint } from '@/route'
import {
  computeTrackTimes,
  formatDuration,
  formatElapsed,
  formatUtcTime,
  type TrackTimes
} from '@/track-times'
import { ProcedureSelector } from '@/ProcedureSelector'
import { emptyProcedureSelection, useLiveWaypoints, type ProcedureAirports } from '@/procedure-selection'
import { parseTransitionAltitudes } from '@/route'
import type { LanConnection, LanLinkState } from './lan-connection'

/**
 * @param link The link to the PC.
 * @returns Its state, kept current.
 */
function useLinkState(link: LanConnection): LanLinkState {
  return useSyncExternalStore(
    (notify) => link.onState(() => notify()),
    () => link.state
  )
}

/**
 * @param link The link to the PC.
 * @param topic A live topic.
 * @returns The topic's latest value, or undefined until the PC has sent one.
 */
function useTopic<T extends LiveTopic>(link: LanConnection, topic: T): LiveTopics[T] | undefined {
  return useSyncExternalStore(
    (notify) => link.subscribe(topic, () => notify()),
    () => link.latest(topic)
  )
}

/**
 * @param props The link to the PC.
 * @returns The element.
 */
export function LanApp({ link }: { link: LanConnection }): React.JSX.Element {
  const state = useLinkState(link)
  if (state === 'needs-pairing' || state === 'wrong-code') {
    return <PairingScreen wrong={state === 'wrong-code'} onPair={(code) => link.pair(code)} />
  }
  if (state === 'starting') return <Centered>{<Connecting />}</Centered>
  return <FlightScreen link={link} offline={state === 'offline'} />
}

function Connecting(): React.JSX.Element {
  const { t } = useTranslation()
  return <p className="text-muted-foreground">{t('lanPage.connecting')}</p>
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-dvh flex-col items-center justify-center gap-4 p-4">{children}</div>
}

/**
 * @param props Whether the last code was wrong, and what to do with a typed one.
 * @returns The element.
 */
function PairingScreen({
  wrong,
  onPair
}: {
  wrong: boolean
  onPair: (code: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  return (
    <Centered>
      <form
        className="flex w-full max-w-sm flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (code.trim() !== '') onPair(code)
        }}
      >
        <h1 className="font-heading text-2xl font-semibold">{t('lanPage.pairTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('lanPage.pairHelp')}</p>
        <label className="flex flex-col gap-1.5 text-sm">
          {t('lanPage.codeLabel')}
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            className="h-12 text-center font-mono text-2xl tracking-widest"
          />
        </label>
        {wrong && (
          <p role="alert" className="text-sm text-destructive">
            {t('lanPage.wrongCode')}
          </p>
        )}
        <Button type="submit" size="lg" className="h-12" disabled={code.length < 6}>
          {t('lanPage.pair')}
        </Button>
      </form>
    </Centered>
  )
}

/**
 * Starts the map's attribution as just its (i) button. MapLibre opens it across the bottom edge on a wide enough screen, which on a phone
 * covers the speed and altitude readout; the licence text is still one tap away.
 */
function useCollapsedAttribution(): void {
  useEffect(() => {
    const collapse = (): void => {
      for (const el of document.querySelectorAll('.maplibregl-ctrl-attrib.maplibregl-compact-show')) {
        el.classList.remove('maplibregl-compact-show')
        el.removeAttribute('open')
      }
    }
    collapse()
    const observer = new MutationObserver(collapse)
    observer.observe(document.body, { childList: true, subtree: true })
    // Only the first opening is undone: once the pilot taps (i), the text stays as they left it.
    const stop = window.setTimeout(() => observer.disconnect(), 5000)
    return () => {
      window.clearTimeout(stop)
      observer.disconnect()
    }
  }, [])
}

/**
 * The flight at a glance along the top: its number, the route, and the aircraft.
 *
 * @param props The flight being tracked.
 * @returns The element.
 */
function FlightBanner({ flight }: { flight: LanFlight }): React.JSX.Element {
  const route = `${realIcao(flight.depIcao) ?? '—'} → ${realIcao(flight.arrIcao) ?? '—'}`
  const aircraft = [flight.registration, flight.icaoType].filter(Boolean).join(' · ')
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-3 py-1.5 text-xs">
      <span className="truncate font-mono font-medium">
        {[flight.flightNumber, route].filter(Boolean).join(' · ')}
      </span>
      {aircraft && <span className="shrink-0 text-muted-foreground">{aircraft}</span>}
    </div>
  )
}

/**
 * ET, time remaining and ETA, as on the Track screen.
 *
 * @param props The readouts.
 * @returns The element, or nothing before there is anything to show.
 */
function TimesBanner({ times }: { times: TrackTimes }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (times.elapsedMs === null && times.remainingMs === null && times.etaMs === null) return null
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-1 text-xs text-muted-foreground">
      <span>
        {t('trackView.times.et')}{' '}
        <span className="font-mono text-foreground">{formatElapsed(times.elapsedMs)}</span>
      </span>
      <span>
        {t('trackView.times.remaining')}{' '}
        <span className="font-mono text-foreground">{formatDuration(times.remainingMs)}</span>
      </span>
      <span>
        {t(times.etaIsPlanned ? 'trackView.times.etaPlanned' : 'trackView.times.eta')}{' '}
        <span className="font-mono text-foreground">{formatUtcTime(times.etaMs)}</span>
      </span>
    </div>
  )
}

/**
 * ET, time remaining and ETA, recalculated every second: ET has to tick on its own, since telemetry stops arriving while the sim is paused.
 *
 * @param args The route, the live telemetry, the recorded track and the scheduled arrival.
 * @returns The readouts.
 */
function useFlightTimes(args: {
  route: [number, number][]
  telemetry: SimTelemetry | undefined
  trackPoints: TrackPoint[]
  schedInUtc: string | null
}): TrackTimes {
  const { route, telemetry, trackPoints, schedInUtc } = args
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return computeTrackTimes({
    route,
    position: telemetry ? { lat: telemetry.latitude, lon: telemetry.longitude } : null,
    groundSpeedMs: telemetry?.groundSpeedMs ?? null,
    onGround: telemetry?.onGround ?? true,
    takeoffUtc: trackPoints.find((p) => !p.onGround)?.tsUtc ?? null,
    schedInUtc,
    now
  })
}

/**
 * @param props The link, and whether it has dropped.
 * @returns The element: the flight view, started afresh for each flight so its procedure choices follow the flight.
 */
function FlightScreen({ link, offline }: { link: LanConnection; offline: boolean }): React.JSX.Element {
  const snapshot = useSyncExternalStore(
    (notify) => link.onFlight(() => notify()),
    () => link.flight
  )
  return (
    <FlightView key={snapshot?.flight.flightId ?? 'none'} link={link} offline={offline} snapshot={snapshot} />
  )
}

/**
 * The Procedures button and what is chosen, as on the Track screen: the SID, STAR and approach, which the PC saves with the flight.
 *
 * @param props The flight's airports, the choice, what to do when it changes, and the route it builds.
 * @returns The element.
 */
function ProceduresBar(props: {
  airports: ProcedureAirports
  selection: ProcedureSelection
  onSelectionChange: (next: ProcedureSelection) => void
  liveWaypoints: Waypoint[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const { selection } = props
  const chosen = [selection.sidIdent, selection.starIdent, selection.approachIdent]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-1">
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-8">
            {t('trackView.proceduresEllipsis')}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('trackView.procedures')}</DialogTitle>
          </DialogHeader>
          <ProcedureSelector {...props} />
        </DialogContent>
      </Dialog>
      <span className="truncate text-xs text-muted-foreground">
        {chosen || t('trackView.nothingSelectedYet')}
      </span>
    </div>
  )
}

/**
 * @param props The link, whether it has dropped, and the flight being tracked (null when none).
 * @returns The element.
 */
function FlightView(props: {
  link: LanConnection
  offline: boolean
  snapshot: LanFlightSnapshot | null
}): React.JSX.Element {
  const { link, offline, snapshot } = props
  const [selection, setSelection] = useState<ProcedureSelection>(
    snapshot?.flight.selection ?? emptyProcedureSelection()
  )
  const trackPoints = useSyncExternalStore(
    (notify) => link.onTrack(notify),
    () => link.track
  )
  const telemetry = useTopic(link, 'simTelemetry') as SimTelemetry | undefined
  const ofpJson = snapshot?.flight.ofpJson ?? null
  const depIcao = snapshot?.flight.depIcao
  const arrIcao = snapshot?.flight.arrIcao
  const airports = useMemo<ProcedureAirports | null>(
    () => (depIcao && arrIcao ? { depIcao, arrIcao, altnIcao: null, ofpJson } : null),
    [depIcao, arrIcao, ofpJson]
  )
  const waypoints = useLiveWaypoints(airports, selection)
  const route = useMemo<[number, number][]>(() => waypoints.map((w) => [w.lon, w.lat]), [waypoints])
  const transition = useMemo(() => parseTransitionAltitudes(ofpJson), [ofpJson])
  const phase = trackPoints.at(-1)?.phase
  const times = useFlightTimes({
    route,
    telemetry,
    trackPoints,
    schedInUtc: snapshot?.flight.schedInUtc ?? null
  })
  useCollapsedAttribution()

  /**
   * Chooses procedures here and tells the PC, which saves them with the flight as its own window's choice does.
   *
   * @param next The new choice.
   */
  const choose = (next: ProcedureSelection): void => {
    setSelection(next)
    try {
      link.command('track.setProcedureSelection', next)
    } catch {
      // Offline: the choice shows here, and the PC keeps its own until the link is back and it is chosen again.
    }
  }

  return (
    <div className="flex h-dvh flex-col">
      <FlightHeader
        offline={offline}
        snapshot={snapshot}
        times={times}
        procedures={
          airports ? { airports, selection, onSelectionChange: choose, liveWaypoints: waypoints } : null
        }
      />
      <div className="min-h-0 flex-1">
        <FlightMap
          live
          route={route}
          waypoints={waypoints}
          trackPoints={trackPoints}
          telemetry={snapshot ? (telemetry ?? null) : null}
          telemetryPhase={phase}
          telemetryTransition={transition}
          depIcao={realIcao(snapshot?.flight.depIcao)}
          arrIcao={realIcao(snapshot?.flight.arrIcao)}
        />
      </div>
    </div>
  )
}

/**
 * Everything above the map: the connection warning, or the flight's banners and Procedures bar.
 *
 * @param props Whether the link dropped, the flight, its times, and the procedures bar's props (null before the flight is known).
 * @returns The element.
 */
function FlightHeader(props: {
  offline: boolean
  snapshot: LanFlightSnapshot | null
  times: TrackTimes
  procedures: Parameters<typeof ProceduresBar>[0] | null
}): React.JSX.Element {
  const { offline, snapshot, times, procedures } = props
  const { t } = useTranslation()
  return (
    <>
      {offline && (
        <p role="status" className="bg-destructive px-4 py-2 text-center text-sm text-white">
          {t('lanPage.offline')}
        </p>
      )}
      {!snapshot && !offline && (
        <p role="status" className="bg-muted px-4 py-2 text-center text-sm text-muted-foreground">
          {t('lanPage.noFlight')}
        </p>
      )}
      {snapshot && <FlightBanner flight={snapshot.flight} />}
      {snapshot && <TimesBanner times={times} />}
      {snapshot && procedures && <ProceduresBar {...procedures} />}
    </>
  )
}
