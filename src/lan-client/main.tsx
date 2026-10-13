/** The second-screen page's entry point: links to the PC and mounts the page. Not covered by unit tests; the acceptance test loads the real build. */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from 'i18next'
import { resolveAppLanguage } from '@shared/app-language'
import '@/i18n'
import './lan.css'
import { LiveClientContext } from '@/live/LiveClient'
import { LanApp } from './LanApp'
import { deviceNameFrom } from './device-name'
import { LanConnection } from './lan-connection'
import { lanLiveClient } from './lan-live-client'
import { codeFromHash } from './pairing-link'
import { installWindowShim } from './window-shim'

const TOKEN_KEY = 'winglog.lan.token'

/** The device token, kept in this browser's local storage when it is available (a private window may refuse it). */
const store = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set: (token: string): void => {
    try {
      localStorage.setItem(TOKEN_KEY, token)
    } catch {
      // The pairing lasts until the page is closed.
    }
  },
  clear: (): void => {
    try {
      localStorage.removeItem(TOKEN_KEY)
    } catch {
      // Nothing stored to clear.
    }
  }
}

document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
i18n.changeLanguage(resolveAppLanguage('system', navigator.language)).catch(() => undefined)

const link = new LanConnection(
  `ws://${location.host}/live`,
  store,
  (url) => new WebSocket(url),
  deviceNameFrom(navigator.userAgent)
)
installWindowShim(link)
link.start()
// A scanned QR code carries the pairing code in the address: use it (once, and take it out of the address bar) when this device is not yet paired.
const scannedCode = codeFromHash(location.hash)
if (scannedCode) {
  history.replaceState(null, '', location.pathname + location.search)
  if (!store.get()) link.pair(scannedCode)
}
// A locked phone suspends the page and its socket: reconnect as soon as it is back, and when the network returns.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') link.resume()
})
window.addEventListener('online', () => link.resume())
window.addEventListener('pageshow', () => link.resume())

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <LiveClientContext.Provider value={lanLiveClient(link)}>
      <LanApp link={link} />
    </LiveClientContext.Provider>
  </StrictMode>
)
