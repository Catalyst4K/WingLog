/** The renderer's LiveClient seam, over the PC link instead of Electron's preload: the page's panels read the same topics. */

import type { LiveClient } from '@/live/LiveClient'
import type { LanConnection } from './lan-connection'

/**
 * @param link The link to the PC.
 * @returns A LiveClient reading the link's topics. Only commands the PC allows a second screen reach anything.
 */
export function lanLiveClient(link: LanConnection): LiveClient {
  return {
    get: (topic) => Promise.resolve(link.latest(topic)),
    subscribe: (topic, listener) => link.subscribe(topic, listener),
    command: (name, ...args) => {
      try {
        link.command(name, ...args)
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error)
      }
    }
  }
}
