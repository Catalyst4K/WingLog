/** Asks the main process what this run of the app is, once, and gives the answer to every screen below (see capabilities-context.ts). */

import { useEffect, useState } from 'react'
import type { AppCapabilities } from '@shared/ipc'
import { winglogApi } from '../data/winglog-api'
import { runAsync } from '../report-error'
import { CapabilitiesContext, HOST_CAPABILITIES } from './capabilities-context'

/**
 * @param props The screens.
 * @returns The element.
 */
export function CapabilitiesProvider(props: { children: React.ReactNode }): React.JSX.Element {
  const [capabilities, setCapabilities] = useState<AppCapabilities>(HOST_CAPABILITIES)
  useEffect(() => {
    runAsync('App appGetCapabilities', winglogApi().appGetCapabilities().then(setCapabilities))
  }, [])
  return <CapabilitiesContext.Provider value={capabilities}>{props.children}</CapabilitiesContext.Provider>
}
