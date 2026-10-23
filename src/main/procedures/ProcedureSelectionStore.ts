/**
 * The SID, STAR and approach chosen for the flight shown, owned by the main process (winglog-backend's
 * docs/plans/taxi-and-second-screen-robustness.md, stage 4). Before this the choice lived in the PC window and reached the main process
 * only while Track was on screen, was written to the flight only when it ended, and was never cleared between flights; a phone saw whatever
 * the window last pushed.
 *
 * Now there is one copy here: loaded from the flight's saved choice whenever the flight shown changes, replaced by whatever the PC window or
 * a phone sets (last one received wins), saved on the flight at every change (so a restart keeps it), and announced to every screen. The
 * suggested approach is decided here too, from the cached navdata, so it appears whichever screen is open and as soon as the airport's data
 * arrives, not when somebody opens a dialog.
 *
 * The flight shown is the one a second screen shows: the tracked flight, else the newest planned one. A plan not yet saved as a flight
 * (Dispatch's) has no copy here; it stays in the window until Fly saves it.
 */

import { EventEmitter } from 'node:events'
import { starLastIdent, suggestApproach } from '@shared/approach-suggestion'
import type { Flight, ProcedureSelection } from '@shared/ipc'
import { arrivalAirport, selectionFromFlight } from '@shared/procedure-selection'
import { logger } from '../logging/logger'
import { assembleFlightRoute } from '../navdata/assemble-flight-route'
import type { SimFacilitiesProvider } from '../navdata/sim-facilities-provider'

/** What the store needs from the rest of the app. */
export interface ProcedureSelectionStoreDeps {
  /** The flight shown with its saved choice, or undefined when there is none. */
  shownFlight(): Flight | undefined
  /** Saves the choice on the flight. */
  save(flightId: number, selection: ProcedureSelection): void
  navdata: Pick<SimFacilitiesProvider, 'listApproaches' | 'getProcedureWaypoints' | 'onAirportRefreshed'>
}

/** Where a change came from, for the log. */
export type SelectionSource = 'window' | 'phone'

interface Shown {
  flight: Flight
  selection: ProcedureSelection
  /** The approach this store suggested, which a later look at the STAR may swap; one the pilot chose is never touched. */
  suggested: string | null
  /** The arrival airports whose approach the pilot cleared ("None"), so it isn't suggested again for them. */
  cleared: Set<string>
}

/** Most changes the suggestion makes in a row (a pick, a swap to the approach the STAR leads into, the transition that joins them). */
const MAX_SUGGESTION_STEPS = 4

const same = (a: ProcedureSelection, b: ProcedureSelection): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

/** The procedure choice of the flight shown. */
export class ProcedureSelectionStore extends EventEmitter<{ changed: [ProcedureSelection | null] }> {
  private shown: Shown | null = null

  constructor(private readonly deps: ProcedureSelectionStoreDeps) {
    super()
    deps.navdata.onAirportRefreshed((icao) => this.guarded('navdata', () => this.onRefreshed(icao)))
  }

  /** @returns The choice for the flight shown, or undefined when there is none. */
  current(): ProcedureSelection | undefined {
    return this.shown?.selection
  }

  /**
   * Looks at which flight is shown. Call it whenever that may have changed: a flight planned, cancelled or deleted, tracking started,
   * stopped or finished, and at start-up. A different flight is loaded with its own saved choice; then the suggestion runs.
   */
  refresh(): void {
    this.guarded('refresh', () => {
      const flight = this.deps.shownFlight()
      if (!flight) {
        if (this.shown) {
          this.shown = null
          this.emit('changed', null)
        }
        return
      }
      if (this.shown?.flight.id !== flight.id) {
        this.shown = { flight, selection: selectionFromFlight(flight), suggested: null, cleared: new Set() }
        this.emit('changed', this.shown.selection)
      }
      this.suggest()
    })
  }

  /**
   * Replaces the choice, from the PC window or a phone: saved on the flight, announced to every screen, and followed by the suggestion
   * (a transition may now join the approach to the STAR). A choice equal to the one held changes nothing, which is what stops an echo.
   * Ignored when no flight is shown.
   *
   * @param selection The new choice.
   * @param source Where it came from.
   */
  set(selection: ProcedureSelection, source: SelectionSource): void {
    this.guarded('set', () => {
      const shown = this.shown
      if (!shown || same(shown.selection, selection)) return
      const before = arrivalAirport(shown.flight, shown.selection)
      const after = arrivalAirport(shown.flight, selection)
      // An approach that goes to "None" for the same airport was cleared by the pilot, so it isn't suggested again.
      if (shown.selection.approachIdent && !selection.approachIdent && before === after)
        shown.cleared.add(after)
      shown.selection = selection
      this.deps.save(shown.flight.id, selection)
      logger.info(`[selection] flight ${shown.flight.id}: ${describe(selection)} (from the ${source})`)
      this.emit('changed', selection)
      this.suggest()
    })
  }

  /** @param icao An airport whose navdata has just been refreshed. */
  private onRefreshed(icao: string): void {
    const shown = this.shown
    if (!shown) return
    if ([shown.flight.depIcao, shown.flight.arrIcao, shown.selection.arrivalIcao].includes(icao))
      this.suggest()
  }

  /** Applies the suggested approach's changes in turn, saving and announcing once if there were any. */
  private suggest(): void {
    const shown = this.shown
    if (!shown) return
    const { flight, cleared } = shown
    let selection = shown.selection
    let suggested = shown.suggested
    for (let step = 0; step < MAX_SUGGESTION_STEPS; step++) {
      const arrIcao = arrivalAirport(flight, selection)
      if (!arrIcao || arrIcao === 'ZZZZ') break
      const change = suggestApproach({
        airports: flight,
        selection,
        options: this.deps.navdata.listApproaches(arrIcao, null),
        starEnd: starLastIdent(assembleFlightRoute(flight, selection, this.deps.navdata).waypoints),
        cleared: cleared.has(arrIcao),
        suggested
      })
      if (!change) break
      selection = { ...selection, ...change.patch }
      suggested = change.suggested
    }
    if (selection === shown.selection) return
    shown.selection = selection
    shown.suggested = suggested
    this.deps.save(flight.id, selection)
    logger.info(`[selection] flight ${flight.id}: ${describe(selection)} (suggested)`)
    this.emit('changed', selection)
  }

  /**
   * Runs one step so a failure (the database, the navdata cache) is logged and goes no further: the caller is an IPC handler, a phone's
   * command or an event, and none of them should throw into the screen that asked.
   *
   * @param what What was being done, for the log.
   * @param step The step.
   */
  private guarded(what: string, step: () => void): void {
    try {
      step()
    } catch (error) {
      logger.warn(`[selection] ${what} failed:`, error)
    }
  }
}

/**
 * @param selection A choice.
 * @returns The choice as a log line says it.
 */
function describe(selection: ProcedureSelection): string {
  const part = (name: string, ident: string | null, transition?: string | null): string =>
    `${name} ${ident ?? '-'}${transition ? ` via ${transition}` : ''}`
  return [
    part('SID', selection.sidIdent, selection.sidTransition),
    part('STAR', selection.starIdent, selection.starTransition),
    part('approach', selection.approachIdent, selection.approachTransition),
    ...(selection.arrivalIcao ? [`arrival ${selection.arrivalIcao}`] : [])
  ].join(', ')
}
