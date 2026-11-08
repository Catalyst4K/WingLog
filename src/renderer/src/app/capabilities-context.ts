/** What this run of the app is (the sim's host or a client of it), read by every screen that hides or changes something for a client. */

import { createContext, useContext } from 'react'
import type { AppCapabilities } from '@shared/ipc'

/** Until the answer arrives, and in every release build: the host WingLog has always been. */
export const HOST_CAPABILITIES: AppCapabilities = { runMode: 'host', canHostSim: true, multiDevice: false }

export const CapabilitiesContext = createContext<AppCapabilities>(HOST_CAPABILITIES)

/**
 * @returns What this run of the app is. A host until the main process has answered, and outside a provider.
 */
export function useCapabilities(): AppCapabilities {
  return useContext(CapabilitiesContext)
}
