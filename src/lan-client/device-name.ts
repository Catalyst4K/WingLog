/** A label for this device that the PC shows in its list of paired devices. */

/** What to look for in the user agent, in order, and the name to give it. */
const DEVICES: [RegExp, string][] = [
  [/iPad/, 'iPad'],
  [/iPhone/, 'iPhone'],
  [/Android.*Mobile/, 'Android phone'],
  [/Android/, 'Android tablet'],
  [/Windows/, 'Windows PC'],
  [/Macintosh/, 'Mac'],
  [/Linux/, 'Linux PC']
]

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, 'Edge'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari']
]

/**
 * @param userAgent The browser's user agent text.
 * @param table Patterns and the names they give.
 * @returns The first matching name, or null.
 */
function firstMatch(userAgent: string, table: [RegExp, string][]): string | null {
  return table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null
}

/**
 * @param userAgent The browser's user agent text.
 * @returns A short name such as "iPad (Safari)" or "Android phone (Chrome)"; "Browser" when nothing is recognised.
 */
export function deviceNameFrom(userAgent: string): string {
  const device = firstMatch(userAgent, DEVICES)
  const browser = firstMatch(userAgent, BROWSERS)
  if (device && browser) return `${device} (${browser})`
  return device ?? browser ?? 'Browser'
}
