import { describe, expect, it } from 'vitest'
import type { GsxRemoteGateInfo, GsxRemoteServiceStatus } from '@shared/ipc'
import {
  formatCargoProgress,
  formatFuelProgress,
  formatGsxBill,
  formatPaxProgress,
  gateSubtitle,
  hiddenServices,
  isSecondaryService,
  isServiceActive,
  parseGsxParking,
  visibleServices
} from './gsx-remote-format'

function makeService(overrides: Partial<GsxRemoteServiceStatus>): GsxRemoteServiceStatus {
  return {
    id: 'Catering',
    displayName: 'Catering',
    state: 'available',
    stateText: '',
    icon: '',
    canTrigger: true,
    canBypass: false,
    statusText: '',
    progressText: '',
    ...overrides
  }
}

describe('gsx-remote-format', () => {
  it('treats any non-"available" state as active', () => {
    expect(isServiceActive(makeService({ state: 'available' }))).toBe(false)
    expect(isServiceActive(makeService({ state: 'requested' }))).toBe(true)
    expect(isServiceActive(makeService({ state: 'performing' }))).toBe(true)
  })

  it('flags the real secondary service ids, not the core turnaround ones', () => {
    expect(isSecondaryService(makeService({ id: 'GPU' }))).toBe(true)
    expect(isSecondaryService(makeService({ id: 'DeIce' }))).toBe(true)
    expect(isSecondaryService(makeService({ id: 'Boarding' }))).toBe(false)
    expect(isSecondaryService(makeService({ id: 'Refueling' }))).toBe(false)
  })

  it('keeps primary services visible and folds idle secondary ones away', () => {
    const services = [
      makeService({ id: 'Boarding', state: 'requested' }),
      makeService({ id: 'GPU', state: 'available' }),
      makeService({ id: 'DeIce', state: 'performing' })
    ]

    expect(visibleServices(services).map((s) => s.id)).toEqual(['Boarding', 'DeIce'])
    expect(hiddenServices(services).map((s) => s.id)).toEqual(['GPU'])
  })

  it('formats a GSX bill as whole-dollar USD, matching GSX\'s own statusText formatting', () => {
    // The currency symbol itself ("$" vs "US$") depends on the runtime's locale (Intl.
    // NumberFormat(undefined, ...), same convention as GsxInvoicesCard) — asserting the
    // digits/grouping/no-decimals is the real behaviour under test, not the symbol.
    const formatted = formatGsxBill(24272)
    expect(formatted).toContain('24,272')
    expect(formatted).not.toContain('.')
  })

  it('formats fuel progress with thousands separators', () => {
    expect(formatFuelProgress({ current: 15357, target: 81488, unit: 'kg' })).toBe('15,357 / 81,488 kg')
  })

  it('formats pax progress', () => {
    expect(formatPaxProgress({ done: 0, total: 344 })).toBe('0 / 344')
  })

  it('formats and capitalizes cargo hold progress', () => {
    expect(formatCargoProgress({ hold: 'front', done: 0, total: 7, unit: 'ULDs' })).toBe('Front: 0 / 7 ULDs')
    expect(formatCargoProgress({ hold: 'rear', done: 3, total: 6, unit: 'ULDs' })).toBe('Rear: 3 / 6 ULDs')
  })

  it('splits a real GSX parking string into gate label and area', () => {
    expect(parseGsxParking('(N) T1 North|Gate N6')).toEqual({ gateLabel: 'Gate N6', area: '(N) T1 North' })
  })

  it('falls back to the whole string as the gate label when there is no "|"', () => {
    expect(parseGsxParking('Gate 12')).toEqual({ gateLabel: 'Gate 12', area: null })
  })

  it('builds a gate subtitle from icao, name and area, skipping a missing area', () => {
    const gate: GsxRemoteGateInfo = { airportIcao: 'VHHH', airportName: 'Hong Kong Intl', parking: '', gateProperties: [] }
    expect(gateSubtitle(gate, '(N) T1 North')).toBe('VHHH · Hong Kong Intl · (N) T1 North')
    expect(gateSubtitle(gate, null)).toBe('VHHH · Hong Kong Intl')
  })
})
