import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { FacilityDataType, RawBuffer } from 'node-simconnect'
import { NavdataDefId } from '../sim/facility-fields'
import { SimAirfieldResolver, simRunwayEnds } from './sim-airfield'

// Kai Tak as the live sim reported it, 2026-09-19 (docs/simconnect-notes.md): one runway
// record, centre point + primary heading + length, idents 13/31.
const KAI_TAK_RUNWAY = {
  latitude: 22.31480285525322,
  longitude: 114.20428276062012,
  headingDeg: 133.88,
  lengthM: 3479.37,
  widthM: 50.4,
  surface: 4,
  primaryIdent: '13',
  secondaryIdent: '31'
}

function runwayBuffer(): RawBuffer {
  const b = new RawBuffer(0)
  b.writeFloat64(KAI_TAK_RUNWAY.latitude)
  b.writeFloat64(KAI_TAK_RUNWAY.longitude)
  b.writeFloat32(KAI_TAK_RUNWAY.headingDeg)
  b.writeFloat32(KAI_TAK_RUNWAY.lengthM)
  b.writeFloat32(KAI_TAK_RUNWAY.widthM)
  b.writeInt32(KAI_TAK_RUNWAY.surface)
  b.writeInt32(13)
  b.writeInt32(0)
  b.writeInt32(31)
  b.writeInt32(0)
  b.setOffset(0)
  return b
}

/** A SimConnect connection double: answers an airport-list request with `airports`, and a
 *  RUNWAYS request with Kai Tak's runway only for `runwayFor`, nothing for anything else. */
function fakeConnection(airports: { icao: string; latitude: number; longitude: number }[], runwayFor: string) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>
  emitter.addToFacilityDefinition = vi.fn()
  emitter.close = vi.fn()
  emitter.requestFacilitiesList = vi.fn(() => {
    queueMicrotask(() =>
      emitter.emit('airportList', {
        requestID: 1,
        entryNumber: 0,
        outOf: 1,
        airports: airports.map((a) => ({ ...a, region: '', altitude: 0 }))
      })
    )
  })
  const requested: string[] = []
  emitter.requestFacilityData = vi.fn((_def: number, _req: number, icao: string) => {
    requested.push(icao)
    queueMicrotask(() => {
      if (icao === runwayFor) {
        emitter.emit('facilityData', {
          userRequestId: NavdataDefId.RUNWAYS,
          type: FacilityDataType.RUNWAY,
          data: runwayBuffer()
        })
      }
      emitter.emit('facilityDataEnd', { userRequestId: NavdataDefId.RUNWAYS })
    })
  })
  return { emitter, requested }
}

const openWith = (emitter: unknown) => vi.fn().mockResolvedValue({ handle: emitter }) as never

describe('simRunwayEnds', () => {
  it('splits the sim runway record into two thresholds half a length either side of the centre', () => {
    const [primary, secondary] = simRunwayEnds('vhhx', KAI_TAK_RUNWAY)
    expect(primary).toMatchObject({ icao: 'VHHX', ident: '13', headingTrueDeg: 133.88, displacedThresholdM: 0 })
    expect(secondary).toMatchObject({ ident: '31' })
    expect(secondary!.headingTrueDeg).toBeCloseTo(313.88, 2)
    expect(primary!.aimingPointDistanceM).toBe(400)
    // The 13 threshold is north-west of the centre, 31's south-east.
    expect(primary!.lat).toBeGreaterThan(KAI_TAK_RUNWAY.latitude)
    expect(primary!.lon).toBeLessThan(KAI_TAK_RUNWAY.longitude)
    expect(secondary!.lat).toBeLessThan(KAI_TAK_RUNWAY.latitude)
  })
})

describe('SimAirfieldResolver', () => {
  const centre = { lat: KAI_TAK_RUNWAY.latitude, lon: KAI_TAK_RUNWAY.longitude }

  it("finds the runway of the sim airfield underneath the touchdown, skipping nearer ones that have none", async () => {
    // A generated helipad is listed closer than Kai Tak and has no runways.
    const { emitter, requested } = fakeConnection(
      [
        { icao: 'VH0VN', latitude: centre.lat + 0.001, longitude: centre.lon },
        { icao: 'VHHX', latitude: centre.lat + 0.004, longitude: centre.lon },
        { icao: 'VHFAR', latitude: centre.lat + 1, longitude: centre.lon } // out of range
      ],
      'VHHX'
    )
    const match = await new SimAirfieldResolver(openWith(emitter)).resolve(centre.lat, centre.lon, 134)
    expect(match?.icao).toBe('VHHX')
    expect(match?.runway.ident).toBe('13')
    expect(requested).toEqual(['VH0VN', 'VHHX'])
    expect(emitter.close).toHaveBeenCalled()
  })

  it('picks the runway end that matches the heading (the reciprocal is 31)', async () => {
    const { emitter } = fakeConnection([{ icao: 'VHHX', latitude: centre.lat, longitude: centre.lon }], 'VHHX')
    const match = await new SimAirfieldResolver(openWith(emitter)).resolve(centre.lat, centre.lon, 314)
    expect(match?.runway.ident).toBe('31')
  })

  it('returns null for an off-airport touchdown (no runway underneath), and for no airports in range', async () => {
    const { emitter } = fakeConnection([{ icao: 'VHHX', latitude: centre.lat, longitude: centre.lon }], 'VHHX')
    // 2 km off the strip laterally.
    expect(await new SimAirfieldResolver(openWith(emitter)).resolve(centre.lat + 0.02, centre.lon + 0.02, 134)).toBeNull()
    const empty = fakeConnection([], '')
    expect(await new SimAirfieldResolver(openWith(empty.emitter)).resolve(centre.lat, centre.lon, 134)).toBeNull()
  })

  it('returns null, without throwing, when the sim cannot be reached', async () => {
    const open = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never
    expect(await new SimAirfieldResolver(open).resolve(centre.lat, centre.lon, 134)).toBeNull()
  })

  it('gives up after its timeout when the sim never answers', async () => {
    vi.useFakeTimers()
    try {
      const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>
      emitter.addToFacilityDefinition = vi.fn()
      emitter.requestFacilitiesList = vi.fn() // never replies
      emitter.close = vi.fn()
      const pending = new SimAirfieldResolver(openWith(emitter)).resolve(centre.lat, centre.lon, 134)
      await vi.advanceTimersByTimeAsync(9_000)
      expect(await pending).toBeNull()
      expect(emitter.close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats an ambiguous-ICAO candidate list as "no runways" for that airport and moves on', async () => {
    const { emitter } = fakeConnection([{ icao: 'VHHX', latitude: centre.lat, longitude: centre.lon }], 'NONE')
    ;(emitter.requestFacilityData as ReturnType<typeof vi.fn>).mockImplementation(() => {
      queueMicrotask(() => emitter.emit('facilityMinimalList', { requestID: NavdataDefId.RUNWAYS, data: [] }))
    })
    expect(await new SimAirfieldResolver(openWith(emitter)).resolve(centre.lat, centre.lon, 134)).toBeNull()
  })
})
