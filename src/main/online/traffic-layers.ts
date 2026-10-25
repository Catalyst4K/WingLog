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
  /** The "Sim traffic button" setting: off, the button is not offered and the sim's layer never draws, whatever its switch says. */
  simOffered: boolean
}

/**
 * @param input The switches, the chosen network and whether the sim traffic button is offered.
 * @returns Which layers draw, and whether the sim's was held back by the network's.
 */
export function decideTrafficLayers(input: TrafficLayerInput): TrafficLayers {
  const networkChosen = input.network !== null && (input.network !== 'ivao' || input.ivaoVidSet)
  const drawNetwork = input.networkOn && networkChosen
  const simWanted = input.simOffered && input.simOn
  return {
    networkOn: input.networkOn,
    simOn: input.simOn,
    simOffered: input.simOffered,
    drawNetwork,
    drawSim: simWanted && !drawNetwork,
    simBlockedByNetwork: simWanted && drawNetwork
  }
}
