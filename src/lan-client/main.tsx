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

installWindowShim()
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
i18n.changeLanguage(resolveAppLanguage('system', navigator.language)).catch(() => undefined)

const link = new LanConnection(
  `ws://${location.host}/live`,
  store,
  (url) => new WebSocket(url),
  deviceNameFrom(navigator.userAgent)
)
link.start()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <LiveClientContext.Provider value={lanLiveClient(link)}>
      <LanApp link={link} />
    </LiveClientContext.Provider>
  </StrictMode>
)
