import { describe, expect, it } from 'vitest'
import type { Aircraft, Flight, Landing } from '@shared/ipc'
import {
  isWingLogLogbookCsv,
  parseLogbook,
  serializeLogbook,
  toLogbookRecord,
  type LogbookRecord
} from './logbook-portable'

function makeFlight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 1,
    aircraftId: 1,
    simRegistration: null,
    simIcaoType: null,
    simTitle: null,
    status: 'completed',
    flightNumber: 'BAW117',
    depIcao: 'EGLL',
    arrIcao: 'KJFK',
    altnIcao: null,
    routeString: null,
    cruiseAltM: null,
    schedOutUtc: null,
    schedInUtc: null,
    actualOutUtc: '2026-09-01T10:00:00.000Z',
    actualOffUtc: null,
    actualOnUtc: null,
    actualInUtc: '2026-09-01T17:30:00.000Z',
    blockMinutes: 450,
    airMinutes: 430,
    fuelPlannedKg: null,
    fuelOutKg: 52000,
    fuelInKg: 8000,
    fuelBurnKg: 44000,
    pax: null,
    cargoKg: null,
    zfwKg: null,
    towKg: null,
    ldwKg: null,
    ofpId: null,
    ofpJson: null,
    simVersion: null,
    createdAt: '2026-09-01T09:00:00.000Z',
    selectedDepartureRunway: null,
    selectedSidIdent: null,
    selectedSidTransition: null,
    selectedStarIdent: null,
    selectedStarTransition: null,
    selectedApproachIdent: null,
    selectedApproachTransition: null,
    selectedArrivalIcao: null,
    ...overrides
  } as Flight
}

const AIRCRAFT = { id: 1, registration: 'G-XWBA', icaoType: 'A35K' } as Aircraft

const LANDING = {
  verticalSpeedMs: -1.5,
  gForce: 1.2345,
  crosswindMs: 3,
  runwayIdent: '04R'
} as Landing

function record(overrides: Partial<LogbookRecord> = {}): LogbookRecord {
  return {
    registration: 'G-XWBA',
    icaoType: 'A35K',
    flightNumber: 'BAW117',
    depIcao: 'EGLL',
    arrIcao: 'KJFK',
    outUtc: '2026-09-01T10:00:00.000Z',
    inUtc: '2026-09-01T17:30:00.000Z',
    blockMinutes: 450,
    airMinutes: 430,
    fuelOutKg: 52000,
    fuelInKg: 8000,
    fuelBurnKg: 44000,
    landing: { touchdownFpm: -295, gForce: 1.23, crosswindKt: 5.8, runway: '04R' },
    ...overrides
  }
}

describe('toLogbookRecord', () => {
  it('flattens a completed flight and its landing, converting to explicit units', () => {
    expect(toLogbookRecord(makeFlight(), AIRCRAFT, LANDING)).toEqual(record())
  })

  it('has a null landing when none was recorded, and a null crosswind when unresolved', () => {
    expect(toLogbookRecord(makeFlight(), AIRCRAFT, undefined)?.landing).toBeNull()
    expect(toLogbookRecord(makeFlight(), AIRCRAFT, { ...LANDING, crosswindMs: null })?.landing?.crosswindKt).toBeNull()
  })

  it('falls back to the sim registration/type for a free flight with no fleet aircraft', () => {
    const free = makeFlight({ aircraftId: null, simRegistration: 'N172SP', simIcaoType: 'C172' })
    expect(toLogbookRecord(free, undefined, undefined)).toEqual(
      expect.objectContaining({ registration: 'N172SP', icaoType: 'C172' })
    )
  })

  it('skips a flight that is not completed, has no block times, or has no identifiable aircraft', () => {
    expect(toLogbookRecord(makeFlight({ status: 'active' }), AIRCRAFT, undefined)).toBeNull()
    expect(toLogbookRecord(makeFlight({ actualInUtc: null }), AIRCRAFT, undefined)).toBeNull()
    expect(toLogbookRecord(makeFlight({ aircraftId: null }), undefined, undefined)).toBeNull()
  })
})

describe('serializeLogbook', () => {
  it('writes a CSV with unit-suffixed headers and the landing flattened into columns', () => {
    const csv = serializeLogbook([record()], 'csv')
    const [header, row] = csv.trimEnd().split('\r\n')
    expect(header).toBe(
      'registration,aircraft_type,flight_number,dep_icao,arr_icao,out_utc,in_utc,block_minutes,air_minutes,fuel_out_kg,fuel_in_kg,fuel_burn_kg,touchdown_fpm,touchdown_g,crosswind_kt,landing_runway'
    )
    expect(row).toBe('G-XWBA,A35K,BAW117,EGLL,KJFK,2026-09-01T10:00:00.000Z,2026-09-01T17:30:00.000Z,450,430,52000,8000,44000,-295,1.23,5.8,04R')
  })

  it('leaves landing columns empty for a flight with no landing', () => {
    const row = serializeLogbook([record({ landing: null })], 'csv').trimEnd().split('\r\n')[1]!
    expect(row.endsWith(',44000,,,,')).toBe(true)
  })

  it('writes JSON with the landing nested', () => {
    const parsed = JSON.parse(serializeLogbook([record()], 'json')) as LogbookRecord[]
    expect(parsed[0]?.landing).toEqual({ touchdownFpm: -295, gForce: 1.23, crosswindKt: 5.8, runway: '04R' })
  })
})

describe('parseLogbook — round trips', () => {
  it('reads back a CSV export exactly, including a flight number that needs quoting', () => {
    const records = [record(), record({ flightNumber: 'A, "B"', landing: null, fuelBurnKg: null, registration: 'G-ÄBCD' })]
    const rows = parseLogbook(serializeLogbook(records, 'csv'), 'csv')
    expect(rows.map((r) => ('record' in r ? r.record : r))).toEqual(records)
  })

  it('reads back a JSON export exactly', () => {
    const records = [record(), record({ landing: null, flightNumber: null })]
    const rows = parseLogbook(serializeLogbook(records, 'json'), 'json')
    expect(rows.map((r) => ('record' in r ? r.record : r))).toEqual(records)
  })
})

describe('parseLogbook — untrusted input', () => {
  const csv = (row: string): string =>
    `registration,aircraft_type,flight_number,dep_icao,arr_icao,out_utc,in_utc,block_minutes\r\n${row}\r\n`

  it('skips a row with a missing or malformed required field, with a label and reason', () => {
    const rows = parseLogbook(csv(',A320,,EGLL,EGCC,2026-09-01T10:00:00Z,2026-09-01T11:00:00Z,60\r\nG-ABCD,A320,,EGLL,EGCC,not-a-date,2026-09-01T11:00:00Z,60'), 'csv')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ error: 'missing or malformed required field', label: 'EGLL-EGCC' })
    expect(rows[1]).toEqual({ error: 'missing or malformed required field', label: 'G-ABCD EGLL-EGCC' })
  })

  it('rejects an in-block time before the out-block time', () => {
    const [row] = parseLogbook(csv('G-ABCD,A320,,EGLL,EGCC,2026-09-01T12:00:00Z,2026-09-01T11:00:00Z,60'), 'csv')
    expect(row).toEqual({ error: 'in-block time is before out-block time', label: 'G-ABCD EGLL-EGCC' })
  })

  it('treats a non-numeric or infinite metric as absent rather than throwing or storing NaN', () => {
    const [row] = parseLogbook(csv('G-ABCD,A320,,EGLL,EGCC,2026-09-01T10:00:00Z,2026-09-01T11:00:00Z,lots'), 'csv')
    expect('record' in row! && row.record.blockMinutes).toBeNull()
    const json = JSON.stringify([{ registration: 'G-ABCD', icaoType: 'A320', depIcao: 'EGLL', arrIcao: 'EGCC', outUtc: '2026-09-01T10:00:00Z', inUtc: '2026-09-01T11:00:00Z', fuelOutKg: '1e999', airMinutes: '45' }])
    const [j] = parseLogbook(json, 'json')
    expect('record' in j! && [j.record.fuelOutKg, j.record.airMinutes]).toEqual([null, 45])
  })

  it('normalises ICAO codes and re-serialises dates to canonical ISO', () => {
    const [row] = parseLogbook(csv('G-ABCD,A320,,egll,eGcc,2026-09-01T10:00:00Z,2026-09-01T11:00:00+00:00,60'), 'csv')
    expect('record' in row! && row.record).toEqual(
      expect.objectContaining({ depIcao: 'EGLL', arrIcao: 'EGCC', outUtc: '2026-09-01T10:00:00.000Z', inUtc: '2026-09-01T11:00:00.000Z' })
    )
  })

  it('rejects rows that are not objects, and documents that are not usable at all', () => {
    expect(parseLogbook('[1, null, "x"]', 'json').every((r) => 'error' in r)).toBe(true)
    expect(() => parseLogbook('{"not":"an array"}', 'json')).toThrow('Expected a JSON array')
    expect(() => parseLogbook('not json', 'json')).toThrow()
    expect(() => parseLogbook('', 'csv')).toThrow('empty')
  })

  it('ignores extra or reordered columns, and never treats a field as code', () => {
    const [row] = parseLogbook(
      'extra,in_utc,out_utc,arr_icao,dep_icao,aircraft_type,registration\r\n=cmd|calc,2026-09-01T11:00:00Z,2026-09-01T10:00:00Z,EGCC,EGLL,A320,G-ABCD\r\n',
      'csv'
    )
    expect('record' in row! && row.record.registration).toBe('G-ABCD')
  })
})

describe('isWingLogLogbookCsv', () => {
  it('recognises our header and not SimToolkitPro\'s', () => {
    expect(isWingLogLogbookCsv(['registration', 'dep_icao'])).toBe(true)
    expect(isWingLogLogbookCsv(['DepartureICAO', 'ArrivalICAO', 'AircraftReg'])).toBe(false)
  })
})
