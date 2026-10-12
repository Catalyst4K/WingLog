/** The renderer's LiveClient seam, over the PC link instead of Electron's preload: the page's panels read the same topics. */

import type { LiveClient } from '@/live/LiveClient'
import type { LanConnection } from './lan-connection'

/**
 * @param link The link to the PC.
 * @returns A LiveClient reading the link's topics. The page is view-only for now, so every command is refused.
 */
export function lanLiveClient(link: LanConnection): LiveClient {
  return {
    get: (topic) => Promise.resolve(link.latest(topic)),
    subscribe: (topic, listener) => link.subscribe(topic, listener),
    command: () => Promise.reject(new Error('This screen is view-only'))
  }
}
