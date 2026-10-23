/**
 * The approach WingLog suggests for a plan that has not been saved as a flight yet (Dispatch's), as a hook. The decision is
 * src/shared/approach-suggestion.ts's: the same one the main process makes for a saved flight (src/main/tracking/ProcedureSelectionStore.ts),
 * so a flight's approach is chosen whichever screen is open and the second screen shows it without the PC window's help. This hook only
 * lists the arrival airport's approaches, refreshes its navdata from the sim, and applies the decision's changes to the local selection.
 */

import { useEffect, useRef, useState } from 'react'
import { starLastIdent, suggestApproach } from '@shared/approach-suggestion'
import type { NavdataProcedureOption, ProcedureSelection } from '@shared/ipc'
import { arrivalAirport, type ProcedureAirports } from '@shared/procedure-selection'
import type { Waypoint } from '@shared/route'
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

  // An approach that goes to "None" for the same plan and airport was cleared by the pilot, on this screen or another, so it isn't
  // suggested again. Runs before the suggestion below, in the same commit.
  useEffect(() => {
    const before = previous.current
    if (memoryKey && before.memoryKey === memoryKey && before.approachIdent && !selection.approachIdent)
      uiMemory().approachCleared.add(memoryKey)
    previous.current = { memoryKey, approachIdent: selection.approachIdent }
  }, [memoryKey, selection.approachIdent])

  // Applies the decision's changes in turn: a pick can be followed by a swap to the approach the STAR leads into and by the transition that
  // joins the two, and the last of them leaves nothing more to do, so this settles after one change of the selection.
  useEffect(() => {
    if (!airports || !options) return
    const starEnd = starLastIdent(liveWaypoints)
    const cleared = memoryKey !== null && uiMemory().approachCleared.has(memoryKey)
    let next = selection
    let suggested = suggestedApproach.current
    for (let step = 0; step < 4; step++) {
      const change = suggestApproach({ airports, selection: next, options, starEnd, cleared, suggested })
      if (!change) break
      next = { ...next, ...change.patch }
      suggested = change.suggested
    }
    if (next === selection) return
    suggestedApproach.current = suggested
    onSelectionChange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSelectionChange is new every render; the airports are covered by their fields
  }, [options, selection, airports?.ofpJson, memoryKey, liveWaypoints])
}
