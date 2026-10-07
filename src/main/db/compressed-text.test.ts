import { describe, expect, it } from 'vitest'
import { compressText, decompressText } from './compressed-text'

/** Something shaped like a SimBrief OFP: a long repetitive navlog. */
function fakeOfp(fixes: number): string {
  return JSON.stringify({
    general: { icao_airline: 'BAW', flight_number: '31', route: 'DCT' },
    navlog: {
      fix: Array.from({ length: fixes }, (_, i) => ({
        ident: `FIX${i}`,
        pos_lat: (45 + i / 1000).toFixed(6),
        pos_long: (10 + i / 500).toFixed(6),
        altitude_feet: '35000',
        via_airway: 'UL9'
      }))
    }
  })
}

describe('compressText / decompressText', () => {
  it('round-trips text exactly, including unicode, an empty string and a large document', () => {
    for (const text of ['', '{}', 'Düsseldorf → 東京 ✈ \u0000 end', fakeOfp(3000)]) {
      expect(decompressText(compressText(text))).toBe(text)
    }
  })

  it('makes a repetitive OFP much smaller', () => {
    const text = fakeOfp(5000)
    const packed = compressText(text)
    expect(packed.length * 5).toBeLessThan(Buffer.byteLength(text, 'utf8'))
  })

  it('starts the stored value with a format marker', () => {
    expect(compressText('x')[0]).toBe(1)
  })

  it('passes text stored before compression existed straight through', () => {
    expect(decompressText('{"legacy":true}')).toBe('{"legacy":true}')
  })

  it('reads a value handed over as a plain byte array too', () => {
    expect(decompressText(new Uint8Array(compressText('bytes')))).toBe('bytes')
  })

  it('refuses a format it does not know, rather than returning garbage', () => {
    expect(() => decompressText(Buffer.from([9, 1, 2, 3]))).toThrow('Unknown compressed text format 9')
  })
})
