import { describe, expect, it } from 'vitest'
import { FacilityDataType, RawBuffer, type RecvFacilityData } from 'node-simconnect'
import { createRunwayCollector } from './runway-collector'

function buffer(write: (b: RawBuffer) => void): RawBuffer {
  const b = new RawBuffer(0)
  write(b)
  b.setOffset(0)
  return b
}

/** A RUNWAY message as the sim sends it, the fields addRunwayFields registers. */
function runwayRecord(uniqueRequestId: number, primary: number, secondary: number): RecvFacilityData {
  return {
    type: FacilityDataType.RUNWAY,
    uniqueRequestId,
    parentUniqueRequestId: 0,
    data: buffer((w) => {
      w.writeFloat64(60.29)
      w.writeFloat64(5.22)
      w.writeFloat32(350.56)
      w.writeFloat32(2982.91)
      w.writeFloat32(45.24)
      w.writeInt32(4)
      w.writeInt32(primary)
      w.writeInt32(0)
      w.writeInt32(secondary)
      w.writeInt32(0)
    })
  } as unknown as RecvFacilityData
}

/** A threshold, which the sim sends as a PAVEMENT message under its runway. */
function thresholdRecord(parentUniqueRequestId: number, lengthM: number): RecvFacilityData {
  return {
    type: FacilityDataType.PAVEMENT,
    uniqueRequestId: 100 + lengthM,
    parentUniqueRequestId,
    data: buffer((w) => w.writeFloat32(lengthM))
  } as unknown as RecvFacilityData
}

describe('createRunwayCollector', () => {
  it('gives each runway the two threshold lengths that follow it, the primary end first (Bergen: 270 m at both ends)', () => {
    const collector = createRunwayCollector()
    collector.take(runwayRecord(1, 35, 17))
    collector.take(thresholdRecord(1, 270))
    collector.take(thresholdRecord(1, 270))
    expect(collector.runways).toHaveLength(1)
    expect(collector.runways[0]).toMatchObject({
      primaryIdent: '35',
      secondaryIdent: '17',
      primaryDisplacedM: 270,
      secondaryDisplacedM: 270
    })
  })

  it('keeps an end that has none apart from one that has, by their order', () => {
    const collector = createRunwayCollector()
    collector.take(runwayRecord(1, 9, 27))
    collector.take(thresholdRecord(1, 0))
    collector.take(thresholdRecord(1, 310))
    expect(collector.runways[0]?.primaryDisplacedM).toBe(0)
    expect(collector.runways[0]?.secondaryDisplacedM).toBe(310)
  })

  it('attaches thresholds to the runway they belong to when several arrive', () => {
    const collector = createRunwayCollector()
    collector.take(runwayRecord(1, 23, 5))
    collector.take(thresholdRecord(1, 0))
    collector.take(thresholdRecord(1, 0))
    collector.take(runwayRecord(2, 20, 2))
    collector.take(thresholdRecord(2, 50))
    collector.take(thresholdRecord(2, 60))
    expect(collector.runways.map((r) => [r.primaryDisplacedM, r.secondaryDisplacedM])).toEqual([
      [0, 0],
      [50, 60]
    ])
  })

  it('leaves a runway whose thresholds never arrived unread, and ignores a third threshold and records that are not runways', () => {
    const collector = createRunwayCollector()
    collector.take(runwayRecord(1, 35, 17))
    collector.take({
      type: FacilityDataType.AIRPORT,
      data: buffer((w) => w.writeString8('ENBR'))
    } as unknown as RecvFacilityData)
    collector.take(thresholdRecord(999, 270))
    expect(collector.runways[0]?.primaryDisplacedM).toBeNull()
    collector.take(thresholdRecord(1, 1))
    collector.take(thresholdRecord(1, 2))
    collector.take(thresholdRecord(1, 3))
    expect(collector.runways[0]).toMatchObject({ primaryDisplacedM: 1, secondaryDisplacedM: 2 })
  })
})
