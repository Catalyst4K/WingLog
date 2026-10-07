/** The Logbook tab: the flight list, each flight's detail, and the landings list. */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Aircraft,
  LogbookFlight,
  LandingDistanceUnit,
  MapLanguage,
  LandingListRow,
  LandingScoreSummary,
  LogbookStats,
  WeightUnit
} from '@shared/ipc'
import { FolderTabs, FolderTabsContent, FolderTabsList, FolderTabsTrigger } from './components/FolderTabs'
import { useResetSignal } from './hooks/use-reset-signal'
import { useSortable } from './hooks/use-sortable'
import { asyncHandler, runAsync } from './report-error'
import { FlightDetailLoader } from './logbook/FlightDetail'
import { SORT_KEYS, compareFlights, type SortKey } from './logbook/sorting'
import { FlightsTable, LogbookStatsStrip } from './logbook/FlightsTable'
import { LandingsTable } from './logbook/LandingsTable'

type View = { kind: 'list' } | { kind: 'detail'; id: number }

/**
 * The Logbook tab.
 *
 * @param props The unit settings, the map language, a flight to open first, and the tab's reset signal.
 * @returns The element.
 */
export function LogbookView(props: {
  weightUnit: WeightUnit
  landingDistanceUnit: LandingDistanceUnit
  mapLanguage?: MapLanguage
  /** Set when another view (e.g. Fleet's per-aircraft flight list) navigated here to open
   *  a specific flight directly, rather than the user picking one from the list. */
  initialFlightId?: number | null
  /** The Fleet aircraft this flight was opened from, if any — used to send "Back" there
   *  instead of Logbook's own list. Only ever meaningful together with initialFlightId. */
  initialFlightOriginAircraftId?: number | null
  /** Called once initialFlightId has been consumed, so navigating here again from a
   *  different tab (this component remounts each time, per App.tsx's conditional render)
   *  doesn't keep reopening the same flight. */
  onInitialFlightConsumed?: () => void
  /** Navigates back to a specific Fleet aircraft — wired to "Back" when the current
   *  detail view is the flight that was opened from that aircraft's flights list. */
  onBackToAircraft?: (aircraftId: number) => void
  /** Bumped by App.tsx when the Logbook tab is clicked while already active — returns to
   *  the flight list without touching sort/filters (docs/plans/navigation-tab-behaviour.md).
   *  Distinct from onInitialFlightConsumed above: that's a remount-time concern (arriving
   *  from elsewhere), this is a same-mount concern (already here). See useResetSignal. */
  resetSignal?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [flights, setFlights] = useState<LogbookFlight[]>([])
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [stats, setStats] = useState<LogbookStats | null>(null)
  const [scores, setScores] = useState<LandingScoreSummary[]>([])
  const [allLandings, setAllLandings] = useState<LandingListRow[] | undefined>(undefined)
  const [view, setView] = useState<View>(
    props.initialFlightId != null ? { kind: 'detail', id: props.initialFlightId } : { kind: 'list' }
  )
  const [loading, setLoading] = useState(true)
  useResetSignal(props.resetSignal, () => setView({ kind: 'list' }))
  // Captured once at mount, independent of the props themselves — App.tsx clears
  // pendingLogbookFlight (nulling these props) right after consuming them, but "was this
  // detail view reached via a Fleet cross-navigation" needs to stay true for as long as
  // the user is looking at that same flight, not just for the first render.
  const [initialFlightId] = useState(props.initialFlightId ?? null)
  const [initialFlightOriginAircraftId] = useState(props.initialFlightOriginAircraftId ?? null)

  useEffect(() => {
    if (props.initialFlightId != null) props.onInitialFlightConsumed?.()
    // Only ever meant to run once, against the initial prop value — see the state
    // initializer above, which already captured it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, for the initial prop
  }, [])

  function reload(): Promise<void> {
    return Promise.all([
      window.winglog.logbookListCompletedFlights(),
      window.winglog.aircraftList(),
      window.winglog.logbookGetStats(),
      window.winglog.logbookListFlightScores(),
      window.winglog.logbookListAllLandings()
    ]).then(([flightList, aircraftList, logbookStats, flightScores, landingRows]) => {
      setFlights(flightList)
      setAircraft(aircraftList)
      setStats(logbookStats)
      setScores(flightScores)
      setAllLandings(landingRows)
    })
  }

  useEffect(() => {
    runAsync(
      'LogbookView reload',
      reload().finally(() => setLoading(false))
    )
  }, [])

  /**
   * A free flight tracked with no fleet aircraft has no aircraftId to look up — falls back
   * to the sim-reported registration recorded directly on the flight row instead.
   *
   * @param flight The flight.
   * @returns Its fleet aircraft's registration, else the one the sim reported, else a dash.
   */
  function registrationFor(flight: LogbookFlight): string {
    if (flight.aircraftId != null) {
      return aircraft.find((a) => a.id === flight.aircraftId)?.registration ?? `#${flight.aircraftId}`
    }
    return flight.simRegistration ?? '—'
  }

  function scoreFor(flightId: number): number | null {
    return scores.find((s) => s.flightId === flightId)?.score ?? null
  }

  /**
   * Landing count for the flights list's "×3" badge (winglog-backend's docs/plans/
   * multiple-landings.md) — 0 for a flight with no landing row, same cases scoreFor
   * returns null for.
   *
   * @param flightId The flight.
   * @returns How many landings it has.
   */
  function landingCountFor(flightId: number): number {
    return scores.find((s) => s.flightId === flightId)?.landingCount ?? 0
  }

  const comparators = Object.fromEntries(
    SORT_KEYS.map((key) => [
      key,
      (a: LogbookFlight, b: LogbookFlight) => compareFlights(a, b, key, registrationFor, scoreFor)
    ])
  ) as Record<SortKey, (a: LogbookFlight, b: LogbookFlight) => number>
  const {
    sortKey,
    sortDir,
    sortedRows: sortedFlights,
    handleSort
  } = useSortable<LogbookFlight, SortKey>(flights, comparators, 'date', 'desc')

  if (view.kind === 'detail') {
    const flight = flights.find((f) => f.id === view.id)
    if (!flight) return <p className="text-sm text-muted-foreground">{t('logbookView.flightNotFound')}</p>
    // Only the exact flight that was opened from Fleet sends "Back" there — navigating
    // to a different flight from Logbook's own list (even after arriving via Fleet)
    // falls back to the ordinary "back to list" behaviour.
    const cameFromFleet = flight.id === initialFlightId && initialFlightOriginAircraftId != null
    return (
      <FlightDetailLoader
        listRow={flight}
        aircraft={aircraft.find((a) => a.id === flight.aircraftId)}
        fleetAircraft={aircraft}
        weightUnit={props.weightUnit}
        landingDistanceUnit={props.landingDistanceUnit}
        mapLanguage={props.mapLanguage}
        backToAircraft={cameFromFleet}
        onBack={
          cameFromFleet
            ? () => {
                if (initialFlightOriginAircraftId != null)
                  props.onBackToAircraft?.(initialFlightOriginAircraftId)
              }
            : () => setView({ kind: 'list' })
        }
        onDeleted={() => {
          setView({ kind: 'list' })
          runAsync('LogbookView reload', reload())
        }}
        onAircraftLinked={asyncHandler('LogbookView reload', () => reload())}
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('logbookView.title')}</h1>

      {!loading && flights.length > 0 && <LogbookStatsStrip stats={stats} flightCount={flights.length} />}

      <FolderTabs defaultValue="flights" className="gap-0">
        <FolderTabsList>
          <FolderTabsTrigger value="flights">{t('logbookView.tabs.flights')}</FolderTabsTrigger>
          <FolderTabsTrigger value="landings">{t('logbookView.tabs.landings')}</FolderTabsTrigger>
        </FolderTabsList>

        <FolderTabsContent value="flights" className="pt-4">
          <FlightsTable
            loading={loading}
            flights={sortedFlights}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            registrationFor={registrationFor}
            scoreFor={scoreFor}
            landingCountFor={landingCountFor}
            weightUnit={props.weightUnit}
            onOpen={(id) => setView({ kind: 'detail', id })}
          />
        </FolderTabsContent>

        <FolderTabsContent value="landings" className="pt-4">
          <LandingsTable landings={allLandings} onOpenFlight={(id) => setView({ kind: 'detail', id })} />
        </FolderTabsContent>
      </FolderTabs>
    </div>
  )
}
