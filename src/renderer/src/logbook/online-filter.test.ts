import { describe, expect, it } from 'vitest'
import type { LogbookFlight } from '@shared/ipc'
import { filterByOnline, hasOnlineFlights } from './online-filter'

function flight(id: number, onlineNetwork: 'vatsim' | 'ivao' | null): LogbookFlight {
  return { id, onlineNetwork } as LogbookFlight
}

const FLIGHTS = [flight(1, null), flight(2, 'vatsim'), flight(3, 'ivao'), flight(4, 'vatsim')]

describe('filterByOnline', () => {
  it('keeps everything for all', () => {
    expect(filterByOnline(FLIGHTS, 'all')).toHaveLength(4)
  })

  it('keeps flights flown on either network for online', () => {
    expect(filterByOnline(FLIGHTS, 'online').map((f) => f.id)).toEqual([2, 3, 4])
  })

  it('keeps one network’s flights', () => {
    expect(filterByOnline(FLIGHTS, 'vatsim').map((f) => f.id)).toEqual([2, 4])
    expect(filterByOnline(FLIGHTS, 'ivao').map((f) => f.id)).toEqual([3])
  })

  it('is empty when nothing matches', () => {
    expect(filterByOnline([flight(1, null)], 'ivao')).toEqual([])
  })
})

describe('hasOnlineFlights', () => {
  it('is true when any flight was flown online', () => {
    expect(hasOnlineFlights(FLIGHTS)).toBe(true)
    expect(hasOnlineFlights([flight(1, null)])).toBe(false)
    expect(hasOnlineFlights([])).toBe(false)
  })
})
