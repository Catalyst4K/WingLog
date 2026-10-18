import { describe, expect, it } from 'vitest'
import { classifyLogo, fingerprint, iataCodesFromCsv, summariseHealth } from './logo-health-lib'

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const OTHER = new Uint8Array([137, 80, 78, 71, 9, 9, 9])
const answer = (status: number, contentType = 'image/png', bytes = PNG) => ({ status, contentType, bytes })

describe('classifyLogo', () => {
  it('calls a real image ok, and a 404 or the service stand-in missing', () => {
    expect(classifyLogo(answer(200), null)).toBe('ok')
    expect(classifyLogo(answer(404, 'text/plain', new Uint8Array()), null)).toBe('missing')
    expect(classifyLogo(answer(200), fingerprint(PNG))).toBe('missing')
    expect(classifyLogo(answer(200, 'image/png', OTHER), fingerprint(PNG))).toBe('ok')
  })

  it('calls anything else an error: a server error, a non-image, an empty body', () => {
    expect(classifyLogo(answer(500), null)).toBe('error')
    expect(classifyLogo(answer(200, 'text/html'), null)).toBe('error')
    expect(classifyLogo(answer(200, 'image/png', new Uint8Array()), null)).toBe('error')
  })
})

describe('iataCodesFromCsv', () => {
  it('takes each two-character IATA code once, upper-cased, and skips airlines without one', () => {
    const csv = [
      'name,icao,iata',
      '135 Airways,GNL,',
      '1Time Airline,RNX,1T',
      'British Airways,BAW,ba',
      'BA again,BAW,BA',
      'Odd,ODD,TOOLONG'
    ].join('\r\n')
    expect(iataCodesFromCsv(csv)).toEqual(['1T', 'BA'])
  })
})

describe('summariseHealth', () => {
  it('groups codes by outcome', () => {
    expect(
      summariseHealth([
        { iata: 'BA', status: 'ok' },
        { iata: 'KA', status: 'missing' },
        { iata: 'XX', status: 'error' }
      ])
    ).toEqual({ checked: 3, ok: ['BA'], missing: ['KA'], error: ['XX'] })
  })
})
