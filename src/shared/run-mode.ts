/**
 * Which computer a WingLog is the sim's: a host (it talks to the sim, records the flight, runs GSX and BeyondATC) or a client (it connects to
 * the host's WingLog over the home network and uses its own database for everything else). winglog-backend's docs/plans/multi-device.md,
 * Part 1. Pure so each case is tested without Electron.
 */

export type RunMode = 'host' | 'client'

/** What the renderer is told once, at startup, about this run of the app. */
export interface AppCapabilities {
  /** What this run is: a client starts none of the host's services and hides their settings. */
  runMode: RunMode
  /** Whether this computer can be the sim's host at all (Windows). */
  canHostSim: boolean
  /** Whether the run mode can be chosen: false in a release build, where the app is always the host it has always been. */
  multiDevice: boolean
}

/** The stored choices, in the order they are tried. */
const RUN_MODES: readonly RunMode[] = ['host', 'client']

/**
 * @param value Text from the settings table.
 * @returns The run mode it names, or null when it is neither.
 */
export function parseRunMode(value: string | null | undefined): RunMode | null {
  return RUN_MODES.find((mode) => mode === value) ?? null
}

/**
 * The run mode a computer starts with before a choice is made: the sim's host where it can be, a client elsewhere.
 *
 * @param canHost Whether this computer can host the sim.
 * @returns The default run mode.
 */
export function defaultRunMode(canHost: boolean): RunMode {
  return canHost ? 'host' : 'client'
}

/**
 * Settles the run mode for this launch.
 *
 * @param stored The saved choice, if any.
 * @param multiDevice Whether multi-device is built in (`__WINGLOG_MULTI_DEVICE__`). When it is not, the app is the host it has always been
 *   and a stored choice is ignored, so a release build can never be put into a mode it does not offer.
 * @param canHost Whether this computer can host the sim. A computer that cannot is always a client, whatever was stored.
 * @returns The run mode to start in.
 */
export function effectiveRunMode(stored: RunMode | null, multiDevice: boolean, canHost: boolean): RunMode {
  if (!multiDevice) return 'host'
  if (!canHost) return 'client'
  return stored ?? defaultRunMode(canHost)
}

/**
 * @param stored The saved choice, if any.
 * @param multiDevice Whether multi-device is built in.
 * @param canHost Whether this computer can host the sim.
 * @returns What the renderer is told about this run.
 */
export function appCapabilities(
  stored: RunMode | null,
  multiDevice: boolean,
  canHost: boolean
): AppCapabilities {
  return { runMode: effectiveRunMode(stored, multiDevice, canHost), canHostSim: canHost, multiDevice }
}
