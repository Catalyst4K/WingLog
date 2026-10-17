/** Collects a RUNWAYS facility request's records into runways, each with its two displaced thresholds. */

import { FacilityDataType, type RecvFacilityData } from 'node-simconnect'
import { parseRunway, parseThresholdLength, type ParsedRunway } from './facility-fields'

export interface RunwayCollector {
  /** The runways read so far, in the order the sim sent them. */
  runways: ParsedRunway[]
  /**
   * Takes one facility record. A RUNWAY record starts a runway; the PAVEMENT records that follow it are its thresholds (the primary
   * end's first, then the secondary's: `addRunwayFields`). Any other record is not a runway's and is ignored.
   *
   * @param recv The facility record from the sim.
   */
  take: (recv: RecvFacilityData) => void
}

/**
 * @returns A collector with no runways yet, for one RUNWAYS request.
 */
export function createRunwayCollector(): RunwayCollector {
  const runways: ParsedRunway[] = []
  const byUniqueRequestId = new Map<number, ParsedRunway>()
  return {
    runways,
    take: (recv) => {
      if (recv.type === FacilityDataType.RUNWAY) {
        const runway = parseRunway(recv.data)
        runways.push(runway)
        byUniqueRequestId.set(recv.uniqueRequestId, runway)
      } else if (recv.type === FacilityDataType.PAVEMENT) {
        const runway = byUniqueRequestId.get(recv.parentUniqueRequestId)
        if (!runway) return
        const length = parseThresholdLength(recv.data)
        if (runway.primaryDisplacedM == null) runway.primaryDisplacedM = length
        else if (runway.secondaryDisplacedM == null) runway.secondaryDisplacedM = length
      }
    }
  }
}
