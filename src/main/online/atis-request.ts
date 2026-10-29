/**
 * Checks the airports a screen asks the ATIS for. The renderer and the second screen are not security boundaries, so main checks every
 * request before it reaches the feed code (winglog-backend docs/plans/online-atis-weather.md).
 */
import type { AtisRequest, AtisSlot } from '@shared/ipc'

/** The most airports one request may name: the panel's four tabs, with room. */
export const MAX_ATIS_REQUESTS = 8

const SLOTS: readonly AtisSlot[] = ['departure', 'destination', 'alternate', 'custom']
const ICAO = /^[A-Za-z0-9]{4}$/

/**
 * @param value What a screen sent.
 * @returns The requests, with each code in upper case.
 * @throws When it is not a list of at most 8 `{ icao, slot }` objects, each a four-character code and one of the four tabs.
 */
export function parseAtisRequests(value: unknown): AtisRequest[] {
  if (!Array.isArray(value) || value.length > MAX_ATIS_REQUESTS) throw new Error('Invalid ATIS request')
  return value.map((entry: unknown) => {
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null
    const icao = record?.icao
    const slot = SLOTS.find((s) => s === record?.slot)
    if (typeof icao !== 'string' || !ICAO.test(icao) || slot === undefined)
      throw new Error('Invalid ATIS request')
    return { icao: icao.toUpperCase(), slot }
  })
}
