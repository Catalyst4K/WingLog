import { describe, expect, it } from 'vitest'
import { fillFromLookup, type LookupFillable } from './lookup-fill'

const blank: LookupFillable = { icaoType: '', operator: '', operatorIata: '', operatorIcao: '' }
const result = { icaoType: 'A359', operator: 'Cathay Pacific Airways', operatorIcao: 'CPA' }
const vendored = { name: 'Cathay Pacific', iata: 'CX', icao: 'CPA' }

describe('fillFromLookup', () => {
  it('fills an empty form from the vendored airline matched by ICAO code', () => {
    expect(fillFromLookup(blank, result, vendored)).toEqual({
      icaoType: 'A359',
      operator: 'Cathay Pacific',
      operatorIata: 'CX',
      operatorIcao: 'CPA'
    })
  })

  it("falls back to the lookup's own operator name and ICAO code when no airline matched", () => {
    expect(fillFromLookup(blank, result, undefined)).toEqual({
      icaoType: 'A359',
      operator: 'Cathay Pacific Airways',
      operatorIata: '',
      operatorIcao: 'CPA'
    })
  })

  it('leaves the operator blank when the lookup has none and nothing matched', () => {
    const noOperator = { icaoType: 'C172', operator: null, operatorIcao: null }
    expect(fillFromLookup(blank, noOperator, undefined)).toEqual({
      icaoType: 'C172',
      operator: '',
      operatorIata: '',
      operatorIcao: ''
    })
  })

  it('never overwrites a type or operator that is already filled in', () => {
    const typed = {
      icaoType: 'A35K',
      operator: 'My Virtual Airline',
      operatorIata: 'MV',
      operatorIcao: 'MVA'
    }
    expect(fillFromLookup(typed, result, vendored)).toEqual(typed)
  })

  it('fills the type but keeps a typed operator', () => {
    const typed = { ...blank, operator: 'My Virtual Airline', operatorIata: 'MV', operatorIcao: 'MVA' }
    expect(fillFromLookup(typed, result, vendored)).toEqual({ ...typed, icaoType: 'A359' })
  })
})
