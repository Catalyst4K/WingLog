/**
 * Which traffic layers draw. The one place the "never both" rule lives: the network's pilots are also injected into the sim, so both
 * would draw the same aircraft twice. The switches turn each other off (`NetworkFeedService`), so both are only on together when stored
 * that way by a build from before (Callum, 2026-10-29); then the network's wins and the sim's reads as off. The ATC layer's switch is
 * independent of both: ATC areas and traffic show together (Callum, 2026-10-29).
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
  /** The ATC layer's switch. */
  atcOn: boolean
}

/**
 * @param input The switches, the chosen network and whether the sim traffic button is offered.
 * @returns Which layers draw.
 */
export function decideTrafficLayers(input: TrafficLayerInput): TrafficLayers {
  const networkChosen = input.network !== null && (input.network !== 'ivao' || input.ivaoVidSet)
  const drawNetwork = input.networkOn && networkChosen
  const simOn = input.simOn && !drawNetwork
  return {
    networkOn: input.networkOn,
    simOn,
    simOffered: input.simOffered,
    atcOn: input.atcOn,
    drawNetwork,
    drawSim: input.simOffered && simOn,
    drawAtc: input.atcOn && networkChosen
  }
}
