import { brotliCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { compressText } from '../db/compressed-text'
import { ofpFromWire, ofpToWire } from './ofp-wire'

describe('ofpToWire', () => {
  it('sends no OFP as null, and an OFP as the compressed bytes in base64', () => {
    expect(ofpToWire(null)).toBeNull()
    const text = JSON.stringify({ route: 'EGLL DCT WSSS' })
    expect(ofpToWire(text)).toBe(compressText(text).toString('base64'))
  })

  it('round-trips text, including text that needs escaping and characters outside ASCII', () => {
    const text = JSON.stringify({ remark: 'quote " backslash \\ slash / é 日本' })
    expect(ofpFromWire({ ofpJsonZ: ofpToWire(text) })).toEqual({ ok: true, fields: { ofpJson: text } })
  })
})

describe('ofpFromWire', () => {
  it('leaves a row from before ofpJsonZ alone: its plain ofpJson is applied as it always was', () => {
    expect(ofpFromWire({ ofpJson: '{"old":true}' })).toEqual({ ok: true, fields: {} })
  })

  it('takes null as no OFP', () => {
    expect(ofpFromWire({ ofpJsonZ: null })).toEqual({ ok: true, fields: { ofpJson: null } })
  })

  it('refuses a value that is not text, is not valid compressed bytes, or is in a format this build does not know', () => {
    expect(ofpFromWire({ ofpJsonZ: 5 })).toEqual({ ok: false, error: 'unreadable OFP' })
    expect(ofpFromWire({ ofpJsonZ: { type: 'Buffer', data: [1, 2] } })).toEqual({
      ok: false,
      error: 'unreadable OFP'
    })
    expect(ofpFromWire({ ofpJsonZ: Buffer.from('not compressed at all').toString('base64') })).toEqual({
      ok: false,
      error: 'unreadable OFP'
    })
    const unknownFormat = Buffer.concat([Buffer.from([9]), brotliCompressSync(Buffer.from('{}'))])
    expect(ofpFromWire({ ofpJsonZ: unknownFormat.toString('base64') })).toEqual({
      ok: false,
      error: 'unreadable OFP'
    })
  })

  it('refuses a small value that unpacks to far more than any OFP could (a decompression bomb)', () => {
    const bomb = compressText('0'.repeat(40 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(100 * 1024)
    expect(ofpFromWire({ ofpJsonZ: bomb.toString('base64') })).toEqual({ ok: false, error: 'unreadable OFP' })
  })
})
