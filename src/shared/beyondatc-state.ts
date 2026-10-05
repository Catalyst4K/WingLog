import type { BeyondAtcState } from './ipc'

/** BeyondATC's state before anything has arrived: the service's starting point in main, and
 *  the initial value for every renderer reader of the `beyondAtcState` live topic. */
export const EMPTY_BEYONDATC_STATE: BeyondAtcState = {
  facility: null,
  com2: null,
  callsign: null,
  commsState: null,
  progress: null,
  actions: [],
  autoTune: null,
  autoRespond: null,
  frequencies: [],
  infoBoxes: []
}
