import { describe, expect, it } from 'vitest'
import { RawBuffer } from 'node-simconnect'
import {
  parseAirportHeader,
  parseEnrouteTransition,
  parseLeg,
  parseProcedureHeader,
  parseRunway,
  parseRunwayTransition,
  runwayIdent
} from './facility-fields'

/** Builds a buffer via RawBuffer's own write* methods (the exact wire format SimConnect
 *  itself would produce), then rewinds it for reading — so these tests exercise the real
 *  round-trip rather than a hand-guessed byte layout. */
function buffer(write: (b: RawBuffer) => void): RawBuffer {
  const b = new RawBuffer(0)
  write(b)
  b.setOffset(0)
  return b
}

describe('runwayIdent', () => {
  it('pads the number to two digits and appends the L/R/C designator', () => {
    expect(runwayIdent(7, 2)).toBe('07R')
    expect(runwayIdent(25, 1)).toBe('25L')
    expect(runwayIdent(9, 3)).toBe('09C')
  })

  it('appends nothing for designator 0 (no L/R/C)', () => {
    expect(runwayIdent(27, 0)).toBe('27')
  })
})

describe('parseAirportHeader', () => {
  it('reads the ICAO field', () => {
    const b = buffer((w) => w.writeString8('EGLL'))
    expect(parseAirportHeader(b)).toEqual({ icao: 'EGLL' })
  })
})

describe('parseRunway', () => {
  it('reads every field in registration order and derives both idents', () => {
    const b = buffer((w) => {
      w.writeFloat64(51.4775)
      w.writeFloat64(-0.4614)
      w.writeFloat32(270)
      w.writeFloat32(3902)
      w.writeFloat32(50)
      w.writeInt32(2) // surface
      w.writeInt32(27)
      w.writeInt32(0) // primary designator: none
      w.writeInt32(9)
      w.writeInt32(0) // secondary designator: none
    })
    const runway = parseRunway(b)
    expect(runway.latitude).toBeCloseTo(51.4775, 6)
    expect(runway.longitude).toBeCloseTo(-0.4614, 6)
    expect(runway.headingDeg).toBeCloseTo(270, 3)
    expect(runway.lengthM).toBeCloseTo(3902, 1)
    expect(runway.widthM).toBeCloseTo(50, 1)
    expect(runway.surface).toBe(2)
    expect(runway.primaryIdent).toBe('27')
    expect(runway.secondaryIdent).toBe('09')
  })
})

describe('parseProcedureHeader', () => {
  it('reads the procedure name and the three child counts', () => {
    const b = buffer((w) => {
      w.writeString8('BPK7F')
      w.writeInt32(2)
      w.writeInt32(3)
      w.writeInt32(4)
    })
    expect(parseProcedureHeader(b)).toEqual({
      name: 'BPK7F',
      nRunwayTransitions: 2,
      nEnrouteTransitions: 3,
      nApproachLegs: 4
    })
  })
})

describe('parseRunwayTransition', () => {
  it('derives the runway ident from number + designator', () => {
    const b = buffer((w) => {
      w.writeInt32(7)
      w.writeInt32(2) // R
      w.writeInt32(5)
    })
    expect(parseRunwayTransition(b)).toEqual({ runwayIdent: '07R', nApproachLegs: 5 })
  })
})

describe('parseEnrouteTransition', () => {
  it('reads the transition name and leg count', () => {
    const b = buffer((w) => {
      w.writeString8('CLEEE')
      w.writeInt32(6)
    })
    expect(parseEnrouteTransition(b)).toEqual({ name: 'CLEEE', nApproachLegs: 6 })
  })
})

describe('parseLeg', () => {
  function legBuffer(overrides: Partial<{ fixIcao: string; fixTypeCode: number }> = {}): RawBuffer {
    return buffer((w) => {
      w.writeInt32(4)
      w.writeString8(overrides.fixIcao ?? 'BPK')
      w.writeInt32(overrides.fixTypeCode ?? 87) // 'W'
      w.writeFloat64(51.5)
      w.writeFloat64(-0.2)
      w.writeInt32(0)
      w.writeFloat32(270)
      w.writeFloat32(6000)
      w.writeFloat32(4000)
      w.writeFloat32(250)
    })
  }

  it('reads every field and decodes the fix-type ASCII code to a letter', () => {
    const leg = parseLeg(legBuffer())
    expect(leg).toEqual({
      type: 4,
      fixIdent: 'BPK',
      fixType: 'W',
      fixLatitude: 51.5,
      fixLongitude: -0.2,
      turnDirection: 0,
      courseDeg: 270,
      altitude1: 6000,
      altitude2: 4000,
      speedLimit: 250
    })
  })

  it('maps every confirmed fix-type code (docs/navdata-notes.md)', () => {
    expect(parseLeg(legBuffer({ fixTypeCode: 87 })).fixType).toBe('W')
    expect(parseLeg(legBuffer({ fixTypeCode: 86 })).fixType).toBe('V')
    expect(parseLeg(legBuffer({ fixTypeCode: 82 })).fixType).toBe('R')
    expect(parseLeg(legBuffer({ fixTypeCode: 78 })).fixType).toBe('N')
  })

  it('returns null fixType for an unrecognised code, e.g. a heading/manual-termination leg with no real fix', () => {
    expect(parseLeg(legBuffer({ fixTypeCode: 0 })).fixType).toBeNull()
  })

  it('returns null fixIdent for a blank FIX_ICAO', () => {
    expect(parseLeg(legBuffer({ fixIcao: '' })).fixIdent).toBeNull()
  })
})
