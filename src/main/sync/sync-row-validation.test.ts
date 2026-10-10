import { describe, expect, it } from 'vitest'
import { aircraft, flight, flightInvoice, landing } from '../db/schema'
import { validateSyncFields } from './sync-row-validation'

describe('validateSyncFields', () => {
  it('keeps the table fields of a good aircraft row, including nulls on nullable columns', () => {
    const result = validateSyncFields(aircraft, {
      registration: 'G-ABCD',
      icaoType: 'A320',
      operator: null,
      currentIcao: 'EGLL'
    })
    expect(result).toEqual({
      ok: true,
      fields: { registration: 'G-ABCD', icaoType: 'A320', operator: null, currentIcao: 'EGLL' }
    })
  })

  it('drops keys the table does not have and the ones the engine sets itself', () => {
    const result = validateSyncFields(
      flight,
      {
        id: 1,
        uuid: 'someone-elses',
        updatedAt: '2099-01-01T00:00:00.000Z',
        aircraftId: 99,
        depIcao: 'EGLL',
        arrIcao: 'EGKK',
        futureField: 'from a newer app version'
      },
      ['aircraftId']
    )
    expect(result).toEqual({ ok: true, fields: { depIcao: 'EGLL', arrIcao: 'EGKK' } })
  })

  it('refuses a number column holding text, NaN or an infinite value', () => {
    for (const bad of ['5', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      const result = validateSyncFields(flight, { depIcao: 'EGLL', arrIcao: 'EGKK', fuelOutKg: bad })
      expect(result).toEqual({ ok: false, error: 'invalid flight data: fuelOutKg must be a finite number' })
    }
  })

  it('refuses a fraction or an unsafe number in an integer column', () => {
    expect(validateSyncFields(flight, { pax: 1.5 })).toEqual({
      ok: false,
      error: 'invalid flight data: pax must be a whole number'
    })
    expect(validateSyncFields(landing, { seq: 2 ** 60 })).toEqual({
      ok: false,
      error: 'invalid landing data: seq must be a whole number'
    })
    expect(validateSyncFields(landing, { seq: 2 })).toEqual({ ok: true, fields: { seq: 2 } })
  })

  it('refuses text that is not text, and an enum value the column does not allow', () => {
    expect(validateSyncFields(aircraft, { registration: 42 })).toEqual({
      ok: false,
      error: 'invalid aircraft data: registration must be text'
    })
    expect(validateSyncFields(flight, { status: 'exploded' })).toEqual({
      ok: false,
      error: 'invalid flight data: status is not one of the allowed values'
    })
    expect(validateSyncFields(flightInvoice, { serviceGroup: 'fuel' })).toEqual({
      ok: true,
      fields: { serviceGroup: 'fuel' }
    })
  })

  it('refuses null in a NOT NULL column', () => {
    expect(validateSyncFields(aircraft, { registration: null })).toEqual({
      ok: false,
      error: 'invalid aircraft data: registration must not be null'
    })
  })

  it('caps ordinary text but allows a whole OFP in its own column', () => {
    expect(validateSyncFields(aircraft, { operator: 'x'.repeat(4097) })).toEqual({
      ok: false,
      error: 'invalid aircraft data: operator is too long'
    })
    expect(validateSyncFields(aircraft, { operator: 'x'.repeat(4096) }).ok).toBe(true)
    expect(validateSyncFields(flight, { ofpJson: 'x'.repeat(5_000_000) }).ok).toBe(true)
    expect(validateSyncFields(flight, { ofpJson: 'x'.repeat(16 * 1024 * 1024 + 1) })).toEqual({
      ok: false,
      error: 'invalid flight data: ofpJson is too long'
    })
  })
})
