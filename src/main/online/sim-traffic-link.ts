/**
 * The real connection for the sim-traffic layer (winglog-backend docs/plans/vatsim-build.md, Step 4b): a SimConnect connection of its own,
 * never the tracking one (the isolation finding in docs/navdata-notes.md), that asks for every aircraft within the SDK's 200 km.
 */
import { Protocol, SimConnectConstants, SimConnectPeriod, SimObjectType } from 'node-simconnect'
import { openSimConnect as defaultOpen } from '../sim/open-simconnect'
import { TRAFFIC_VARS, readTrafficRecord, type SimTrafficRecord } from '../sim/simvars'
import type { SimTrafficHandlers, SimTrafficLink } from './SimTrafficService'

const APP_NAME = 'WingLog traffic'
const DEFINITION_ID = 1
const USER_REQUEST_ID = 10
const TRAFFIC_REQUEST_ID = 11
/** SimConnect's largest radius, metres. */
const RADIUS_M = 200_000

/**
 * @param handlers Where the sim's answers go.
 * @param open Opens a SimConnect connection; injected so tests need no sim.
 * @returns The open connection.
 * @throws When the sim cannot be reached.
 */
export async function openSimTrafficLink(
  handlers: SimTrafficHandlers,
  open: typeof defaultOpen = defaultOpen
): Promise<SimTrafficLink> {
  const { handle } = await open(APP_NAME, Protocol.SunRise)
  TRAFFIC_VARS.forEach((v, index) =>
    handle.addToDataDefinition(DEFINITION_ID, v.name, v.unit, v.dataType, 0, index)
  )
  let sweep: SimTrafficRecord[] = []
  handle.on('simObjectData', (recv) => {
    if (recv.requestID === USER_REQUEST_ID) handlers.onUser(recv.objectID)
  })
  handle.on('simObjectDataByType', (recv) => {
    if (recv.requestID !== TRAFFIC_REQUEST_ID) return
    sweep.push(readTrafficRecord(recv.data, recv.objectID))
    if (recv.entryNumber === recv.outOf) {
      const done = sweep
      sweep = []
      handlers.onSweep(done)
    }
  })
  // MSFS exiting fires both: 'quit' from the sim's own message, then 'close' from the socket.
  handle.on('quit', handlers.onLost)
  handle.on('close', handlers.onLost)
  handle.requestDataOnSimObject(
    USER_REQUEST_ID,
    DEFINITION_ID,
    SimConnectConstants.OBJECT_ID_USER,
    SimConnectPeriod.SECOND
  )
  return {
    requestSweep: () =>
      handle.requestDataOnSimObjectType(TRAFFIC_REQUEST_ID, DEFINITION_ID, RADIUS_M, SimObjectType.AIRCRAFT),
    close: () => handle.close()
  }
}
