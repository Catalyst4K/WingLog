/**
 * The Dispatch tab's state: the lists it loads once (fleet, last-parked stands, fleet stats, past
 * flights) and the "Plan a flight" form. DispatchView calls these in this order.
 */

import { winglogApi } from '../data/winglog-api'
import { isRetired } from '@shared/aircraft'
import { useEffect, useState } from 'react'
import {
  defaultDispatchOptions,
  dispatchOptionsToUrlParams,
  type DispatchOptions
} from '@shared/dispatch-options'
import type {
  Aircraft,
  AircraftLastParked,
  DispatchOfp,
  DispatchOpenSimBriefParams,
  FleetStats,
  Flight,
  NewFlight,
  ProcedureSelection
} from '@shared/ipc'
import { defaultDepartureTime, toSimBriefDeparture } from '../dispatch-time'
import { runAsync } from '../report-error'

/** What Dispatch loads when the tab opens. */
export interface DispatchLists {
  aircraft: Aircraft[]
  setAircraft: React.Dispatch<React.SetStateAction<Aircraft[]>>
  lastParked: AircraftLastParked[]
  fleetStats: FleetStats[]
  pastFlights: Flight[]
  generationAvailable: boolean
}

/**
 * Loads the fleet (not retired), the last-parked stands, the fleet stats, whether SimBrief
 * generation is available, and the past flights, once on mount.
 *
 * @returns The lists, and a setter for the fleet (a saved airframe updates one aircraft).
 */
export function useDispatchLists(): DispatchLists {
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [lastParked, setLastParked] = useState<AircraftLastParked[]>([])
  const [fleetStats, setFleetStats] = useState<FleetStats[]>([])
  const [pastFlights, setPastFlights] = useState<Flight[]>([])
  const [generationAvailable, setGenerationAvailable] = useState(false)

  useEffect(() => {
    // Retired aircraft (replacedByAircraftId set — docs/plans/aircraft-replacement.md) have
    // no flights of their own left and shouldn't be offered anywhere an aircraft is picked.
    runAsync(
      'DispatchView aircraftList',
      winglogApi()
        .aircraftList()
        .then((list) => setAircraft(list.filter((a) => !isRetired(a))))
    )
    // Without it, Dispatch just shows no last-parked hint.
    runAsync('DispatchView fleetListLastParked', winglogApi().fleetListLastParked().then(setLastParked))
    runAsync('DispatchView logbookFleetStats', winglogApi().logbookFleetStats().then(setFleetStats))
    runAsync(
      'DispatchView dispatchGenerationAvailable',
      winglogApi().dispatchGenerationAvailable().then(setGenerationAvailable)
    )
    // Source list for the advanced dialog's "Load settings from a previous flight" —
    // flightList already returns newest-first (docs/decisions.md).
    runAsync('DispatchView flightList', winglogApi().flightList().then(setPastFlights))
  }, [])

  return { aircraft, setAircraft, lastParked, fleetStats, pastFlights, generationAvailable }
}

/** The "Plan a flight" form. */
export interface PlanForm {
  planAircraftId: number | null
  depIcao: string
  setDepIcao: (icao: string) => void
  destIcao: string
  setDestIcao: (icao: string) => void
  airlineIcao: string
  setAirlineIcao: (icao: string) => void
  flightNumber: string
  setFlightNumber: (flightNumber: string) => void
  departureUtc: Date | null
  setDepartureUtc: (departure: Date | null) => void
  dispatchOptions: DispatchOptions
  setDispatchOptions: (options: DispatchOptions) => void
  /** Picks the aircraft and prefills departure, airline and time from it. */
  chooseAircraft: (id: number, aircraft: Aircraft[], fleetStats: FleetStats[]) => void
  /** Clears the form after a plan is flown. */
  reset: () => void
}

/**
 * The "Plan a flight" form's fields.
 *
 * @returns The fields, their setters, and the prefill and reset actions.
 */
export function usePlanForm(): PlanForm {
  const [planAircraftId, setPlanAircraftId] = useState<number | null>(null)
  const [depIcao, setDepIcao] = useState('')
  const [destIcao, setDestIcao] = useState('')
  // Airline ICAO prefills from the selected aircraft's operatorIcao but stays editable —
  // an aircraft with a free-typed operator (no code resolved) leaves this blank rather
  // than blocking the flight-number field entirely.
  const [airlineIcao, setAirlineIcao] = useState('')
  const [flightNumber, setFlightNumber] = useState('')
  // Defaulted once, on aircraft selection, per dispatch-time.ts's own doc comment — not
  // re-derived on every render, or the value would silently drift under the user while
  // they fill in the rest of the form.
  const [departureUtc, setDepartureUtc] = useState<Date | null>(null)
  const [dispatchOptions, setDispatchOptions] = useState<DispatchOptions>(defaultDispatchOptions())

  function chooseAircraft(id: number, aircraft: Aircraft[], fleetStats: FleetStats[]): void {
    setPlanAircraftId(id)
    const selected = aircraft.find((a) => a.id === id)
    // Same fallback as the Fleet detail page's "Current airport": stored currentIcao
    // first, then the last completed flight's arrival airport — most of an imported
    // fleet has no currentIcao set (CSV import deliberately doesn't backfill it) but
    // does have real flight history to derive a location from.
    const lastArrIcao = fleetStats.find((s) => s.aircraftId === id)?.lastArrIcao
    setDepIcao(selected?.currentIcao ?? lastArrIcao ?? '')
    setAirlineIcao(selected?.operatorIcao ?? '')
    setDepartureUtc(defaultDepartureTime(new Date()))
  }

  function reset(): void {
    setPlanAircraftId(null)
    setDepIcao('')
    setDestIcao('')
    setAirlineIcao('')
    setFlightNumber('')
    setDepartureUtc(null)
    setDispatchOptions(defaultDispatchOptions())
  }

  return {
    planAircraftId,
    depIcao,
    setDepIcao,
    destIcao,
    setDestIcao,
    airlineIcao,
    setAirlineIcao,
    flightNumber,
    setFlightNumber,
    departureUtc,
    setDepartureUtc,
    dispatchOptions,
    setDispatchOptions,
    chooseAircraft,
    reset
  }
}

/**
 * The SimBrief request for the planned flight, shared by "Plan on SimBrief" and "Generate".
 *
 * @param form The plan form.
 * @param selected The aircraft chosen in it.
 * @returns The request.
 */
export function planRequest(form: PlanForm, selected: Aircraft): DispatchOpenSimBriefParams {
  return {
    origIcao: form.depIcao,
    destIcao: form.destIcao,
    icaoType: selected.icaoType,
    simbriefAirframeId: selected.simbriefAirframeId,
    simbriefType: selected.simbriefType,
    airlineIcao: form.airlineIcao || null,
    flightNumber: form.flightNumber || null,
    departure: form.departureUtc ? toSimBriefDeparture(form.departureUtc) : null,
    extra: dispatchOptionsToUrlParams(form.dispatchOptions)
  }
}

/**
 * The planned flight to create from an OFP, its aircraft and the procedure selection.
 *
 * @param ofp The OFP.
 * @param aircraftId The fleet aircraft flying it.
 * @param selection The chosen runway and procedures.
 * @returns The flightCreate parameters.
 */
export function flightFromOfp(
  ofp: DispatchOfp,
  aircraftId: number,
  selection: ProcedureSelection
): NewFlight {
  return {
    aircraftId,
    flightNumber: ofp.flightNumber,
    depIcao: ofp.depIcao,
    arrIcao: ofp.arrIcao,
    altnIcao: ofp.altnIcao,
    routeString: ofp.routeString,
    cruiseAltM: ofp.cruiseAltM,
    schedOutUtc: ofp.schedOutUtc,
    schedInUtc: ofp.schedInUtc,
    fuelPlannedKg: ofp.fuelPlannedKg,
    pax: ofp.pax,
    cargoKg: ofp.cargoKg,
    zfwKg: ofp.zfwKg,
    towKg: ofp.towKg,
    ldwKg: ofp.ldwKg,
    ofpId: ofp.ofpId,
    ofpJson: ofp.ofpJson,
    selectedDepartureRunway: selection.departureRunway,
    selectedSidIdent: selection.sidIdent,
    selectedSidTransition: selection.sidTransition,
    selectedStarIdent: selection.starIdent,
    selectedStarTransition: selection.starTransition,
    selectedApproachIdent: selection.approachIdent,
    selectedApproachTransition: selection.approachTransition,
    selectedArrivalIcao: selection.arrivalIcao
  }
}
