/**
 * The page has no Electron preload, but the shared map code reads a few lookups through `window.winglog` (airfield lists, taxi charts,
 * stands, ATC transcript). The second screen shows none of those, so each answers "nothing here" and the map draws without them.
 */

/** Installs the stand-in `window.winglog`. */
export function installWindowShim(): void {
  const known: Record<string, (...args: never[]) => unknown> = {
    navdataHasTaxiNetwork: () => Promise.resolve(false),
    navdataRefreshTaxiNetwork: () => Promise.resolve(),
    onBeyondAtcTranscript: () => () => undefined
  }
  const shim = new Proxy(known, {
    get: (target, name) => {
      if (typeof name === 'string' && name in target) return target[name]
      return () => Promise.resolve([])
    }
  })
  Object.defineProperty(window, 'winglog', { value: shim, configurable: true })
}
