import { describe, expect, it } from 'vitest'
import type { DispatchOpenSimBriefParams } from '../../shared/ipc'
import { dispatchOptionsToUrlParams, type DispatchOptions } from '@shared/dispatch-options'
import { buildGenerateUrl, extractSavedAirframeId, GENERATE_PARTITION } from './simbrief-generate'

const BASE: DispatchOpenSimBriefParams = {
  origIcao: 'EGLL',
  destIcao: 'WSSS',
  icaoType: 'A388',
  simbriefAirframeId: null
}

describe('GENERATE_PARTITION', () => {
  it('is a persisted partition, so the SimBrief popup session survives an app restart', () => {
    // flight-test-findings-2026-09-06.md #10 — a regression here would be silent
    // otherwise (nothing else breaks, SimBrief just quietly stops persisting logins).
    expect(GENERATE_PARTITION.startsWith('persist:')).toBe(true)
  })
})

describe('buildGenerateUrl', () => {
  it('builds a minimal URL against the keyed worker endpoint', () => {
    const url = new URL(buildGenerateUrl(BASE, 'abc123', 1788307200))
    expect(url.origin + url.pathname).toBe('https://www.simbrief.com/ofp/ofp.loader.api.php')
    expect(url.searchParams.get('orig')).toBe('EGLL')
    expect(url.searchParams.get('dest')).toBe('WSSS')
    expect(url.searchParams.get('type')).toBe('A388')
    expect(url.searchParams.get('apicode')).toBe('abc123')
    expect(url.searchParams.get('timestamp')).toBe('1788307200')
    expect(url.searchParams.get('outputpage')).toBe('winglog.local/generate')
  })

  it('prefers a saved airframe ID over simbriefType and icaoType for `type`', () => {
    const url = new URL(
      buildGenerateUrl({ ...BASE, simbriefAirframeId: '123456_1582090020', simbriefType: 'A20N' }, 'abc123', 1788307200)
    )
    expect(url.searchParams.get('type')).toBe('123456_1582090020')
  })

  it('prefers simbriefType over the bare icaoType when there is no saved airframe', () => {
    const url = new URL(buildGenerateUrl({ ...BASE, simbriefType: 'A20N' }, 'abc123', 1788307200))
    expect(url.searchParams.get('type')).toBe('A20N')
  })

  it('appends airline/fltnum/date/deph/depm only when present', () => {
    const withExtras: DispatchOpenSimBriefParams = {
      ...BASE,
      airlineIcao: 'BAW',
      flightNumber: '002',
      departure: { dateEpochSeconds: 1788307200, hour: 18, minute: 25 }
    }
    const url = new URL(buildGenerateUrl(withExtras, 'abc123', 1788307200))
    expect(url.searchParams.get('airline')).toBe('BAW')
    expect(url.searchParams.get('fltnum')).toBe('002')
    expect(url.searchParams.get('date')).toBe('1788307200')
    expect(url.searchParams.get('deph')).toBe('18')
    expect(url.searchParams.get('depm')).toBe('25')

    const withoutExtras = new URL(buildGenerateUrl(BASE, 'abc123', 1788307200))
    expect(withoutExtras.searchParams.has('airline')).toBe(false)
    expect(withoutExtras.searchParams.has('fltnum')).toBe(false)
    expect(withoutExtras.searchParams.has('date')).toBe(false)
  })

  it('passes through advanced dispatch-options extras', () => {
    const url = new URL(buildGenerateUrl({ ...BASE, extra: [['units', 'KGS'], ['contpct', '0.03']] }, 'abc123', 1788307200))
    expect(url.searchParams.get('units')).toBe('KGS')
    expect(url.searchParams.get('contpct')).toBe('0.03')
  })

  // Every field the Advanced tab can set (src/renderer/src/dispatch-options.ts), fed
  // through its own real dispatchOptionsToUrlParams — not a hand-picked subset — to catch
  // a field silently dropped or renamed between the advanced dialog and the keyed
  // generation URL, which the smaller spot-check above wouldn't necessarily surface.
  it('round-trips every real Advanced-tab field into the generation URL', () => {
    const filledOptions: DispatchOptions = {
      pax: 'auto',
      cargo: '2000',
      manualzfw: '65000',
      manualpayload: '18000',
      fuelfactor: '1.02',
      addedfuel: '500',
      contpct: '0.03',
      resvrule: '45',
      taxiout: '15',
      taxiin: '10',
      tankering: '0',
      civalue: '85',
      cruisemode: 'LRC',
      cruisesub: 'auto',
      fl: '370',
      climb: '250/300/.78',
      descent: '.78/300/250',
      route: 'DCT',
      origrwy: '27L',
      destrwy: '02C'
    }
    const extra = dispatchOptionsToUrlParams(filledOptions)
    // Sanity check on the fixture itself — every field above is set, so this should be a
    // 1:1 mapping with no accidental omissions before it's even fed through the URL builder.
    expect(extra).toHaveLength(Object.keys(filledOptions).length)

    const url = new URL(buildGenerateUrl({ ...BASE, extra }, 'abc123', 1788307200))
    for (const [field, value] of extra) {
      expect(url.searchParams.get(field), `field "${field}"`).toBe(value)
    }
  })
})

describe('extractSavedAirframeId', () => {
  // Real URL a spike watched a WingLog-owned BrowserWindow navigate to right after a
  // real "Save Airframe" click (docs/plans/simbrief-airframe-picker.md, 2026-09-07).
  it('extracts the airframe id from a real post-save navigation', () => {
    expect(extractSavedAirframeId('https://dispatch.simbrief.com/airframes/saved/1788802707601')).toBe(
      '1788802707601'
    )
  })

  // Every other navigation the share → login → save flow actually passes through, per
  // the same live spike — none of these should be mistaken for the save itself.
  it('returns null for every other navigation the share/login flow passes through', () => {
    expect(extractSavedAirframeId('https://dispatch.simbrief.com/airframes/share/80_1709125568637')).toBeNull()
    expect(extractSavedAirframeId('https://identity.api.navigraph.com/login?signin=abc123')).toBeNull()
    expect(
      extractSavedAirframeId('https://appleid.apple.com/auth/authorize?client_id=com.navigraph.identity-service')
    ).toBeNull()
    expect(extractSavedAirframeId('https://dispatch.simbrief.com/airframes')).toBeNull()
  })
})
