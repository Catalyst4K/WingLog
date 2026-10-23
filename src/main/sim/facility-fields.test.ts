import { describe, expect, it } from 'vitest'
import { RawBuffer } from 'node-simconnect'
import {
  addRunwayFields,
  biasToLatLon,
  parseAirportHeader,
  parseAirportHeaderWithLatLon,
  parseApproachHeader,
  parseEnrouteTransition,
  parseLeg,
  parseProcedureHeader,
  parseRunway,
  parseRunwayTransition,
  parseTaxiName,
  parseThresholdLength,
  parseTaxiPath,
  parseTaxiPoint,
  runwayIdent,
  standLabel
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

describe('the runway thresholds', () => {
  it("registers each end's threshold length inside the runway, the primary end's first (live 2026-10-17)", () => {
    const names: string[] = []
    addRunwayFields((name) => names.push(name))
    expect(names.slice(-8)).toEqual([
      'SECONDARY_DESIGNATOR',
      'OPEN PRIMARY_THRESHOLD',
      'LENGTH',
      'CLOSE PRIMARY_THRESHOLD',
      'OPEN SECONDARY_THRESHOLD',
      'LENGTH',
      'CLOSE SECONDARY_THRESHOLD',
      'CLOSE RUNWAY'
    ])
  })

  it('reads a threshold record as one float32, the displaced length in metres', () => {
    expect(parseThresholdLength(buffer((w) => w.writeFloat32(270)))).toBeCloseTo(270, 3)
    expect(parseThresholdLength(buffer((w) => w.writeFloat32(0)))).toBe(0)
  })

  it('leaves both displaced lengths unread when only the runway record has been parsed', () => {
    const b = buffer((w) => {
      w.writeFloat64(60.29)
      w.writeFloat64(5.22)
      w.writeFloat32(350.56)
      w.writeFloat32(2982.91)
      w.writeFloat32(45.24)
      w.writeInt32(4)
      w.writeInt32(35)
      w.writeInt32(0)
      w.writeInt32(17)
      w.writeInt32(0)
    })
    const runway = parseRunway(b)
    expect(runway.primaryDisplacedM).toBeNull()
    expect(runway.secondaryDisplacedM).toBeNull()
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

describe('parseApproachHeader', () => {
  function approachBuffer(
    type: number,
    suffixCode: number,
    runwayNumber: number,
    runwayDesignator: number
  ): RawBuffer {
    return buffer((w) => {
      w.writeInt32(type)
      w.writeInt32(suffixCode)
      w.writeInt32(runwayNumber)
      w.writeInt32(runwayDesignator)
      w.writeInt32(1)
      w.writeInt32(4)
      w.writeInt32(5)
    })
  }

  it('builds "ILS 07C" for a real ILS approach with no suffix', () => {
    // type=4, suffixCode=48 ('0') — real VHHH ILS 07C values, docs/navdata-notes.md.
    const header = parseApproachHeader(approachBuffer(4, 48, 7, 3))
    expect(header).toEqual({
      identifier: 'ILS 07C',
      runwayIdent: '07C',
      nTransitions: 1,
      nFinalApproachLegs: 4,
      nMissedApproachLegs: 5
    })
  })

  it('builds "RNAV Z 07R" for a suffixed RNP approach — real VHHH Y/Z pair scenario', () => {
    // type=10, suffixCode=90 ('Z') — real VHHH RNP Z 07R values.
    const header = parseApproachHeader(approachBuffer(10, 90, 7, 2))
    expect(header.identifier).toBe('RNAV Z 07R')
  })

  it('falls back to a raw "TYPE n" label for an unrecognized type code, rather than guessing', () => {
    const header = parseApproachHeader(approachBuffer(99, 48, 9, 1))
    expect(header.identifier).toBe('TYPE 99 09L')
  })
})

describe('parseLeg', () => {
  function legBuffer(
    overrides: Partial<{
      fixIcao: string
      fixTypeCode: number
      routeDistanceM: number
      type: number
      courseDeg: number
    }> = {}
  ): RawBuffer {
    return buffer((w) => {
      w.writeInt32(overrides.type ?? 4)
      w.writeString8(overrides.fixIcao ?? 'BPK')
      w.writeInt32(overrides.fixTypeCode ?? 87) // 'W'
      w.writeFloat64(51.5)
      w.writeFloat64(-0.2)
      w.writeInt32(0)
      w.writeFloat32(overrides.courseDeg ?? 270)
      w.writeFloat32(6000)
      w.writeFloat32(4000)
      w.writeFloat32(250)
      w.writeFloat32(overrides.routeDistanceM ?? 0)
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
      speedLimit: 250,
      routeDistanceM: 0
    })
  })

  it("reads ROUTE_DISTANCE (metres) — EGLL ILS 27R's LAM transition FC leg, confirmed live 2026-09-18", () => {
    const leg = parseLeg(
      legBuffer({ type: 9, fixIcao: 'LAM', fixTypeCode: 86, courseDeg: 272, routeDistanceM: 20372 })
    )
    expect(leg.type).toBe(9)
    expect(leg.courseDeg).toBe(272)
    expect(leg.routeDistanceM).toBe(20372) // 11.0 nm — the FMC's "LAM/11"
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

describe('parseAirportHeaderWithLatLon', () => {
  it('reads ICAO + LATITUDE + LONGITUDE, real EGKB reference point', () => {
    const b = buffer((w) => {
      w.writeString8('EGKB')
      w.writeFloat64(51.33098021149635)
      w.writeFloat64(0.03246232867240906)
    })
    expect(parseAirportHeaderWithLatLon(b)).toEqual({
      icao: 'EGKB',
      latitude: 51.33098021149635,
      longitude: 0.03246232867240906
    })
  })
})

describe('parseTaxiPoint', () => {
  it('reads TYPE/BIAS_X/BIAS_Z, a NORMAL point not being hold-short', () => {
    const b = buffer((w) => {
      w.writeInt32(1)
      w.writeFloat32(389.0379)
      w.writeFloat32(823.5693)
    })
    const point = parseTaxiPoint(b)
    expect(point.holdShort).toBe(false)
    expect(point.biasX).toBeCloseTo(389.0379, 2)
    expect(point.biasZ).toBeCloseTo(823.5693, 2)
  })

  it.each([2, 4, 5, 6])('treats TYPE %i as a hold-short point (SDK enum; 5 seen live at VHHH)', (type) => {
    const b = buffer((w) => {
      w.writeInt32(type)
      w.writeFloat32(0)
      w.writeFloat32(0)
    })
    expect(parseTaxiPoint(b).holdShort).toBe(true)
  })
})

describe('parseTaxiPath', () => {
  /**
   * @param fields A path as the 2026-10-21 spike read it at VHHH.
   * @returns Its record, in addTaxiPathFields' order.
   */
  function path(fields: {
    type: number
    width: number
    runwayNumber: number
    runwayDesignator: number
    start: number
    end: number
    nameIndex: number
  }): RawBuffer {
    return buffer((w) => {
      w.writeInt32(fields.type)
      w.writeFloat32(fields.width)
      w.writeUint32(41_248)
      w.writeInt32(fields.runwayNumber)
      w.writeInt32(fields.runwayDesignator)
      w.writeInt32(fields.start)
      w.writeInt32(fields.end)
      w.writeUint32(fields.nameIndex)
    })
  }

  it('reads a taxiway, whose runway fields are garbage and dropped', () => {
    const b = path({
      type: 4,
      width: 25,
      runwayNumber: 2_066_413_472,
      runwayDesignator: 16_476,
      start: 3117,
      end: 3109,
      nameIndex: 1
    })
    expect(parseTaxiPath(b)).toEqual({
      type: 4,
      widthM: 25,
      weight: 41_248,
      runwayNumber: null,
      runwayDesignator: null,
      start: 3117,
      end: 3109,
      nameIndex: 1
    })
    expect(b.remaining()).toBe(0)
  })

  it('keeps the runway number and designator on a runway path (VHHH 07C)', () => {
    const parsed = parseTaxiPath(
      path({ type: 2, width: 58, runwayNumber: 7, runwayDesignator: 3, start: 3232, end: 23, nameIndex: 0 })
    )
    expect(parsed).toMatchObject({ type: 2, widthM: 58, runwayNumber: 7, runwayDesignator: 3 })
  })

  it('maps NAME_INDEX 0 to null — the real "no name" sentinel, confirmed live 2026-09-28, not a missing/error case', () => {
    const parsed = parseTaxiPath(
      path({ type: 2, width: 58, runwayNumber: 7, runwayDesignator: 3, start: 3232, end: 23, nameIndex: 0 })
    )
    expect(parsed.nameIndex).toBeNull()
  })
})

describe('parseTaxiName', () => {
  it('reads NAME as a 32-character field', () => {
    const b = buffer((w) => w.writeString32('A'))
    expect(parseTaxiName(b)).toEqual({ name: 'A' })
    expect(b.remaining()).toBe(0)
  })
})

describe('biasToLatLon', () => {
  it('returns the reference point unchanged for zero bias', () => {
    const result = biasToLatLon(51.33098021149635, 0.03246232867240906, 0, 0)
    expect(result.latitude).toBeCloseTo(51.33098021149635, 9)
    expect(result.longitude).toBeCloseTo(0.03246232867240906, 9)
  })

  it('east/north bias moves latitude/longitude in the expected direction', () => {
    const result = biasToLatLon(51.33098021149635, 0.03246232867240906, 1000, 1000)
    expect(result.latitude).toBeGreaterThan(51.33098021149635) // north = higher latitude
    expect(result.longitude).toBeGreaterThan(0.03246232867240906) // east = higher longitude
  })

  it("matches EGKB runway 03/21's real heading and length within noise — confirmed live 2026-09-28 (winglog-backend docs/navdata-notes.md)", () => {
    // Real TAXI_POINT values for the runway centerline's two extreme threshold points,
    // captured live against Callum's MSFS session. Real RUNWAY facility data for the same
    // airport: HEADING 25.64043617248535 deg, LENGTH 1800.79833984375 m.
    const refLat = 51.33098021149635
    const refLon = 0.03246232867240906
    const start = biasToLatLon(refLat, refLon, 389.03790283203125, 823.5693359375)
    const end = biasToLatLon(refLat, refLon, -394.4898376464844, -794.517333984375)

    const toRad = (deg: number): number => (deg * Math.PI) / 180
    const bearingDeg = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
      const dLon = toRad(lon2 - lon1)
      const y = Math.sin(dLon) * Math.cos(toRad(lat2))
      const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon)
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
    }
    const distanceM = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
      const R = 6371000
      const dLat = toRad(lat2 - lat1)
      const dLon = toRad(lon2 - lon1)
      const a =
        Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
      return 2 * R * Math.asin(Math.sqrt(a))
    }

    const bearing = bearingDeg(start.latitude, start.longitude, end.latitude, end.longitude)
    const distance = distanceM(start.latitude, start.longitude, end.latitude, end.longitude)

    // A straight segment's bearing is only defined up to which end you start from (START/END
    // are arbitrary, not "inbound"/"outbound") - either direction matching the real runway's
    // published heading (25.64 deg) is the correct confirmation, same as the live spike found
    // (25.8 deg one way, its reciprocal ~205.8 the other). Real length 1800.8m either way.
    const reciprocal = (bearing + 180) % 360
    const closestToReal = Math.min(Math.abs(bearing - 25.64), Math.abs(reciprocal - 25.64))
    expect(closestToReal).toBeLessThan(0.5)
    expect(distance).toBeCloseTo(1800.8, -2)
  })
})

describe('standLabel', () => {
  it('names a stand the way ATC says it (real VHHH N32 and YBBN gate 79, 2026-10-02)', () => {
    expect(standLabel(25, 32)).toBe('N32') // GATE_N
    expect(standLabel(12, 4)).toBe('A4') // GATE_A
    expect(standLabel(37, 1)).toBe('Z1') // GATE_Z
    expect(standLabel(10, 79)).toBe('79') // GATE
    expect(standLabel(1, 72)).toBe('72') // PARKING
    expect(standLabel(5, 3)).toBe('3') // SE_PARKING
  })
})
