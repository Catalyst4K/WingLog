/**
 * The approach WingLog suggests when nothing is chosen yet, as a hook. SimBrief never plans an approach, so one is picked from the
 * arrival airport's navdata once its list is in, swapped for the one the STAR leads into once the STAR's waypoints are known, and
 * joined to the STAR's last fix by the approach's own transition when one starts there.
 *
 * Called by the views that are on screen while a flight is planned or flown (Dispatch, Track), not by the Procedures dialog, so the
 * map and a second screen show the approach without the dialog ever being opened. The phone doesn't call it: the PC's choice is the
 * one in force, and its suggestion reaches the phone with the route.
 */

import { useEffect, useRef, useState } from 'react'
import type { NavdataProcedureOption, ProcedureSelection } from '@shared/ipc'
import { arrivalAirport, type ProcedureAirports } from '@shared/procedure-selection'
import {
  approachConnectingToStar,
  approachRunway,
  parseRouteProcedures,
  pickDefaultApproachIdentifier,
  type Waypoint
} from '@shared/route'
import { winglogApi } from './data/winglog-api'
import { realIcao } from './display-icao'
import { runAsync } from './report-error'
import { uiMemory } from './ui-memory'

/**
 * @param airports The flight's airports.
 * @param arrIcao The airport the approach is for (the destination, or the alternate).
 * @returns The key `uiMemory().approachCleared` remembers a cleared approach under, for this plan and airport.
 */
function approachMemoryKey(airports: ProcedureAirports, arrIcao: string): string {
  return `${airports.depIcao}>${arrIcao}|${airports.ofpJson?.slice(0, 300) ?? ''}`
}

/**
 * @param options A procedure list.
 * @param identifier The procedure.
 * @returns The procedure's named transitions, each once.
 */
export function transitionsFor(options: NavdataProcedureOption[], identifier: string | null): string[] {
  return [
    ...new Set(
      options
        .filter((o) => o.identifier === identifier)
        .map((o) => o.transition)
        .filter((t): t is string => t !== null)
    )
  ]
}

/**
 * @param waypoints The assembled route.
 * @returns The ident of the STAR's last waypoint, or null when the route has no STAR.
 */
function starLastIdent(waypoints: Waypoint[]): string | null {
  return [...waypoints].reverse().find((w) => w.segment === 'star')?.ident ?? null
}

/**
 * The arrival airport's approaches: read from the cache straight away, then again once both airports' navdata has been refreshed
 * from the sim. The refresh is tried again each time `isSimConnected` changes, since one tried before the sim was running fails.
 *
 * @param depIcao The departure airport, or null.
 * @param arrIcao The arrival airport, or null when there is none.
 * @param isSimConnected Whether the sim is connected.
 * @returns The approaches, tagged with the airport they were listed for, or null before the first list is in.
 */
function useApproachOptions(
  depIcao: string | null,
  arrIcao: string | null,
  isSimConnected: boolean
): { icao: string; options: NavdataProcedureOption[] } | null {
  const [listed, setListed] = useState<{ icao: string; options: NavdataProcedureOption[] } | null>(null)
  useEffect(() => {
    if (!arrIcao) return undefined
    let ignore = false
    const list = (): Promise<void> =>
      winglogApi()
        .navdataListApproaches(arrIcao, null)
        // An airport the cache doesn't have yet has no approaches to suggest from.
        .catch(() => [])
        .then((options) => {
          if (!ignore) setListed({ icao: arrIcao, options })
        })
    const airports = [...new Set([depIcao, arrIcao].filter((icao): icao is string => icao !== null))]
    runAsync(
      'useDefaultApproach navdata',
      list()
        .then(() => Promise.allSettled(airports.map((icao) => winglogApi().navdataRefreshAirport(icao))))
        .then(list)
    )
    return () => {
      ignore = true
    }
  }, [depIcao, arrIcao, isSimConnected])
  return listed
}

/**
 * Suggests an approach when none is chosen, and keeps the suggestion joined to the STAR (see the file header).
 *
 * @param airports The flight's airports, or null when there is no flight.
 * @param selection The selection.
 * @param onSelectionChange Applies a changed selection.
 * @param liveWaypoints The route assembled from the selection, for the STAR's last fix.
 * @param isSimConnected Whether the sim is connected; navdata a refresh couldn't fetch earlier is fetched again when it connects.
 */
export function useDefaultApproach(
  airports: ProcedureAirports | null,
  selection: ProcedureSelection,
  onSelectionChange: (next: ProcedureSelection) => void,
  liveWaypoints: Waypoint[],
  isSimConnected = false
): void {
  const arrIcao = airports ? realIcao(arrivalAirport(airports, selection)) : null
  const listed = useApproachOptions(realIcao(airports?.depIcao), arrIcao, isSimConnected)
  // The list for the airport in use now: switching to the alternate leaves the destination's in place until the new one is in.
  const options = listed && listed.icao === arrIcao ? listed.options : null
  const memoryKey = airports && arrIcao ? approachMemoryKey(airports, arrIcao) : null
  // The approach WingLog itself suggested, so a later look at the STAR may swap it; one the pilot chose is never touched.
  const suggestedApproach = useRef<string | null>(null)

  // The approach and airport seen last, so a clear can be told from a switch of airport.
  const previous = useRef<{ memoryKey: string | null; approachIdent: string | null }>({
    memoryKey,
    approachIdent: selection.approachIdent
  })

  function set(patch: Partial<ProcedureSelection>): void {
    onSelectionChange({ ...selection, ...patch })
  }

  // An approach that goes to "None" for the same plan and airport was cleared by the pilot, on this screen or another, so it isn't
  // suggested again. Runs before the suggestion below, in the same commit.
  useEffect(() => {
    const before = previous.current
    if (memoryKey && before.memoryKey === memoryKey && before.approachIdent && !selection.approachIdent)
      uiMemory().approachCleared.add(memoryKey)
    previous.current = { memoryKey, approachIdent: selection.approachIdent }
  }, [memoryKey, selection.approachIdent])

  useEffect(() => {
    if (!airports || selection.approachIdent || !options?.length || !memoryKey) return
    if (uiMemory().approachCleared.has(memoryKey)) return
    // The OFP's planned runway is the filed destination's, not the alternate's.
    const plannedRunway =
      arrIcao === airports.arrIcao ? parseRouteProcedures(airports.ofpJson).arrivalRunway : null
    const candidates = plannedRunway
      ? options.filter((o) => approachRunway(o.identifier) === plannedRunway)
      : options
    // Prefer an approach the STAR leads into (ZJSY: UPRS2C ends at SY498, ILS Z 08's entry).
    const pick = pickDefaultApproachIdentifier(candidates, starLastIdent(liveWaypoints))
    if (pick) {
      suggestedApproach.current = pick
      set({ approachIdent: pick })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set is new every render; arrIcao and memoryKey cover the airports
  }, [options, arrIcao, selection.approachIdent, airports?.ofpJson, memoryKey, liveWaypoints])

  // The default can be picked before the STAR's waypoints are in, when it couldn't prefer the approach the STAR leads into. Once
  // they are, it's checked the way a BeyondATC clearance's approach is (same function) and swapped when it doesn't connect.
  useEffect(() => {
    if (!options || !selection.approachIdent || suggestedApproach.current !== selection.approachIdent) return
    const starEnd = starLastIdent(liveWaypoints)
    if (!starEnd) return
    const swap = approachConnectingToStar(
      options,
      selection,
      approachRunway(selection.approachIdent),
      starEnd
    )
    if (!swap) return
    suggestedApproach.current = swap.approachIdent
    set(swap)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set is new every render
  }, [selection.approachIdent, selection.approachTransition, options, liveWaypoints])

  // An approach transition named after the STAR's last fix starts where the STAR ends (docs/navdata-notes.md). Only an empty
  // transition is filled; a deliberate choice is never overwritten.
  useEffect(() => {
    if (!options || !selection.approachIdent || selection.approachTransition) return
    const starEnd = starLastIdent(liveWaypoints)
    if (!starEnd) return
    if (transitionsFor(options, selection.approachIdent).includes(starEnd))
      set({ approachTransition: starEnd })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set is new every render
  }, [selection.approachIdent, selection.approachTransition, options, liveWaypoints])
}
