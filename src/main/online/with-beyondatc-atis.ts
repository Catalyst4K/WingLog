/**
 * Puts BeyondATC's ATIS into the weather panel's answer (winglog-backend docs/plans/beyondatc-atis.md): first in each airport's list, ahead of
 * the network's, and only when BeyondATC is connected and not hidden. Pure.
 */
import type { AirportAtis, AtisAnswer, AtisRequest, BeyondAtcAtisList, WeatherAtis } from '@shared/ipc'

/**
 * @param answer The network's answer: no airports at all when no network is chosen.
 * @param beyondAtc BeyondATC's ATIS as read for this ask.
 * @param requests The airports and tabs asked about.
 * @returns The answer with BeyondATC's ATIS added; unchanged while BeyondATC is off. An airport BeyondATC has no ATIS for is left as it was, and
 *   when BeyondATC did not answer, each airport says so.
 */
export function withBeyondAtcAtis(
  answer: AtisAnswer,
  beyondAtc: BeyondAtcAtisList,
  requests: AtisRequest[]
): AtisAnswer {
  if (beyondAtc.state === 'off') return answer
  const base: AirportAtis[] =
    answer.airports.length > 0
      ? answer.airports
      : requests.map(({ icao, slot }) => ({ icao, slot, state: 'none', atis: [] }))
  const airports = base.map((airport) => {
    const own: WeatherAtis[] = beyondAtc.airports
      .filter((atis) => atis.icao === airport.icao)
      .map((atis) => ({
        callsign: 'BeyondATC',
        code: atis.code,
        kind: 'single',
        lines: [atis.text],
        runway: null,
        source: 'beyondatc',
        arrivalRunways: atis.arrivalRunways,
        departureRunways: atis.departureRunways
      }))
    const atis = [...own, ...airport.atis]
    return {
      ...airport,
      atis,
      state: atis.length > 0 ? ('shown' as const) : airport.state,
      ...(beyondAtc.state === 'unavailable' ? { beyondAtcUnavailable: true } : {})
    }
  })
  return { network: answer.network, airports }
}
