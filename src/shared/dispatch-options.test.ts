import { describe, expect, it } from 'vitest'
import {
  countSetOptions,
  defaultDispatchOptions,
  dispatchOptionsFromApiParams,
  dispatchOptionsToUrlParams
} from './dispatch-options'

// Trimmed real api_params block (docs/simbrief-notes.md, 2026-09-02 reference response),
// plus the general.costindex sibling field civalue is actually read from.
function fixtureOfpJson(
  overrides: {
    api_params?: Record<string, unknown>
    general?: Record<string, unknown>
  } = {}
): string {
  return JSON.stringify({
    general: { costindex: '200', ...overrides.general },
    api_params: {
      pax: 'auto',
      cargo: '0',
      manualzfw: 'auto',
      manualpayload: 'auto',
      fuelfactor: '1',
      addedfuel: '0',
      contpct: 'auto',
      resvrule: 'auto',
      taxiout: '20',
      taxiin: '8',
      tankering: '0',
      cruisemode: 'CI',
      cruisesub: 'auto',
      fl: {},
      climb: '250/320/84',
      descent: '85/300/250',
      route: 'DET2G DET L6 DVR UL9 KONAN',
      origrwy: '27L',
      destrwy: '20R',
      ...overrides.api_params
    }
  })
}

describe('dispatchOptionsFromApiParams', () => {
  it('translates the real api_params fixture, reading civalue from general.costindex', () => {
    const options = dispatchOptionsFromApiParams(fixtureOfpJson())
    expect(options).not.toBeNull()
    expect(options?.pax).toBe('auto')
    expect(options?.cargo).toBe('0')
    expect(options?.manualzfw).toBe('auto')
    expect(options?.contpct).toBe('auto')
    expect(options?.taxiout).toBe('20')
    expect(options?.taxiin).toBe('8')
    expect(options?.climb).toBe('250/320/84')
    expect(options?.descent).toBe('85/300/250')
    expect(options?.route).toBe('DET2G DET L6 DVR UL9 KONAN')
    expect(options?.origrwy).toBe('27L')
    expect(options?.destrwy).toBe('20R')
    expect(options?.civalue).toBe('200')
  })

  it('treats an empty SimBrief field ({}) as unset, not "[object Object]"', () => {
    const options = dispatchOptionsFromApiParams(fixtureOfpJson())
    expect(options?.fl).toBeNull()
  })

  it('preserves "auto" as a distinct value from unset or "0"', () => {
    const options = dispatchOptionsFromApiParams(fixtureOfpJson())
    expect(options?.resvrule).toBe('auto')
    expect(options?.cargo).not.toBe('auto')
    expect(options?.cargo).toBe('0')
  })

  it('reads civalue as null when general.costindex is empty ({})', () => {
    const options = dispatchOptionsFromApiParams(fixtureOfpJson({ general: { costindex: {} } }))
    expect(options?.civalue).toBeNull()
  })

  it('returns null when the OFP JSON has no api_params section', () => {
    expect(dispatchOptionsFromApiParams(JSON.stringify({ general: { costindex: '200' } }))).toBeNull()
  })

  it('returns null for malformed/non-JSON input rather than throwing', () => {
    expect(dispatchOptionsFromApiParams('not json')).toBeNull()
    expect(dispatchOptionsFromApiParams('null')).toBeNull()
    expect(dispatchOptionsFromApiParams('"just a string"')).toBeNull()
  })
})

describe('round trip: fromApiParams -> toUrlParams', () => {
  it('produces the documented INPUT parameter names, not the echoed ones', () => {
    const options = dispatchOptionsFromApiParams(fixtureOfpJson())!
    const params = Object.fromEntries(dispatchOptionsToUrlParams(options))
    expect(params.civalue).toBe('200')
    expect(params.cruisemode).toBe('CI')
    // The echoed names (dephour/depmin/notams_opt/pounds) are a different module's
    // concern (dispatch-time.ts) — nothing here should ever produce them.
    expect(params).not.toHaveProperty('dephour')
  })

  it('"auto" survives the round trip unchanged', () => {
    const options = dispatchOptionsFromApiParams(fixtureOfpJson())!
    const params = Object.fromEntries(dispatchOptionsToUrlParams(options))
    expect(params.pax).toBe('auto')
    expect(params.resvrule).toBe('auto')
  })

  it('omits unset fields entirely rather than sending an empty value', () => {
    const options = dispatchOptionsFromApiParams(fixtureOfpJson())!
    const params = Object.fromEntries(dispatchOptionsToUrlParams(options))
    expect(params).not.toHaveProperty('fl')
  })
})

describe('defaultDispatchOptions / dispatchOptionsToUrlParams', () => {
  it('an all-default options object produces no URL parameters at all', () => {
    expect(dispatchOptionsToUrlParams(defaultDispatchOptions())).toEqual([])
  })

  it('countSetOptions is 0 for defaults and counts only non-null fields otherwise', () => {
    const options = defaultDispatchOptions()
    expect(countSetOptions(options)).toBe(0)
    options.civalue = '85'
    options.pax = 'auto'
    expect(countSetOptions(options)).toBe(2)
  })
})
