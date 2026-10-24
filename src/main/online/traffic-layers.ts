/**
 * Which traffic layers draw. The one place the "never both" rule lives: while the network's traffic is drawn the sim's is not, whatever
 * its switch says (the network's pilots are also injected into the sim, so both would draw the same aircraft twice).
 */
import type { OnlineNetwork, TrafficLayers } from '@shared/ipc'

/** What the decision depends on. */
export interface TrafficLayerInput {
  networkOn: boolean
  simOn: boolean
  network: OnlineNetwork | null
  ivaoVidSet: boolean
  /** False until the sim's own traffic can be read. */
  simAvailable: boolean
}

/**
 * @param input The switches, the chosen network and what is available.
 * @returns Which layers draw, and whether the sim's was held back by the network's.
 */
export function decideTrafficLayers(input: TrafficLayerInput): TrafficLayers {
  const networkChosen = input.network !== null && (input.network !== 'ivao' || input.ivaoVidSet)
  const drawNetwork = input.networkOn && networkChosen
  return {
    networkOn: input.networkOn,
    simOn: input.simOn,
    drawNetwork,
    drawSim: input.simOn && input.simAvailable && !drawNetwork,
    simBlockedByNetwork: input.simOn && drawNetwork
  }
}
