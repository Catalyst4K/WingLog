import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimConnectConstants, SimConnectDataType, SimConnectPeriod, type RawBuffer } from 'node-simconnect'
import type { SimConnectionStatus, SimTelemetry } from '@shared/ipc'
import type { TouchdownSeverity } from './SimConnectSource'
import { SimConnectService, type OpenSimConnect } from './SimConnectService'
import { SIM_VARS } from './simvars'

/** A RawBuffer double: every read method returns a fixed, type-appropriate value. */
function fakeRawBuffer(): RawBuffer {
  return {
    readFloat64: () => 42,
    readInt32: () => 1,
    readString32: () => 'TEST',
    readString128: () => 'Test Aircraft'
  } as unknown as RawBuffer
}

const DEFAULT_TELEMETRY: SimTelemetry = {
  latitude: 51.4775,
  longitude: -0.4614,
  altitudeM: 1000,
  pressureAltitudeM: 1000,
  altitudeAglM: 1000,
  verticalSpeedMs: 0,
  indicatedAirspeedMs: 70,
  trueAirspeedMs: 70,
  machSpeed: 0.1,
  groundSpeedMs: 65,
  headingTrueDeg: 270,
  pitchDeg: -2,
  bankDeg: 0,
  onGround: false,
  gForce: 1,
  fuelTotalKg: 10000,
  totalWeightKg: 70000,
  windSpeedMs: 3,
  windDirectionDeg: 250,
  engineCombustion1: true,
  gearHandlePosition: 1,
  flapsHandleIndex: 0,
  parkingBrakeOn: false,
  atcId: 'TEST',
  atcModel: 'A320',
  title: 'Test Aircraft',
  simRate: 1,
  slewActive: false
}

/** A RawBuffer double for the baseline (1 Hz) request: reproduces SIM_VARS' own read order
 *  so `spec.read(data)` for every field pulls the right, type-appropriate value back out —
 *  needed to drive SimConnectService's high-rate arm/re-arm logic, which reads altitudeAglM
 *  and onGround off this exact stream. */
function fakeTelemetryBuffer(overrides: Partial<SimTelemetry> = {}): RawBuffer {
  const telemetry: SimTelemetry = { ...DEFAULT_TELEMETRY, ...overrides }
  const float64s: number[] = []
  const int32s: number[] = []
  const string32s: string[] = []
  const string128s: string[] = []
  for (const spec of SIM_VARS) {
    const value: unknown = telemetry[spec.key]
    switch (spec.dataType) {
      case SimConnectDataType.FLOAT64:
        float64s.push(value as number)
        break
      case SimConnectDataType.INT32:
        int32s.push(typeof value === 'boolean' ? (value ? 1 : 0) : (value as number))
        break
      case SimConnectDataType.STRING32:
        string32s.push(value as string)
        break
      case SimConnectDataType.STRING128:
        string128s.push(value as string)
        break
    }
  }
  return {
    readFloat64: () => float64s.shift() as number,
    readInt32: () => int32s.shift() as number,
    readString32: () => string32s.shift() as string,
    readString128: () => string128s.shift() as string
  } as unknown as RawBuffer
}

/** A RawBuffer double for the high-rate request: just VERTICAL SPEED then SIM ON GROUND,
 *  matching the order SimConnectService's own addToDataDefinition calls declare them in. */
function fakeHighRateBuffer(verticalSpeedMs: number, onGround: boolean): RawBuffer {
  return {
    readFloat64: () => verticalSpeedMs,
    readInt32: () => (onGround ? 1 : 0)
  } as unknown as RawBuffer
}

function fakeHandle(): EventEmitter & {
  close: () => void
  addToDataDefinition: () => void
  requestDataOnSimObject: () => void
  subscribeToSystemEvent: () => void
} {
  const emitter = new EventEmitter() as EventEmitter & {
    close: () => void
    addToDataDefinition: () => void
    requestDataOnSimObject: () => void
    subscribeToSystemEvent: () => void
  }
  emitter.close = vi.fn()
  emitter.addToDataDefinition = vi.fn()
  emitter.requestDataOnSimObject = vi.fn()
  emitter.subscribeToSystemEvent = vi.fn()
  return emitter
}

describe('SimConnectService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits connected status and telemetry once the sim responds', async () => {
    const handle = fakeHandle()
    const openSimConnect = vi.fn(async () => ({
      recvOpen: { simConnectVersionMajor: 12, simConnectVersionMinor: 2 },
      handle
    })) as unknown as OpenSimConnect

    const service = new SimConnectService(openSimConnect)
    const statuses: SimConnectionStatus[] = []
    const telemetry: SimTelemetry[] = []
    service.on('status', (status) => statuses.push(status))
    service.on('telemetry', (t) => telemetry.push(t))

    service.start()
    await vi.waitFor(() => expect(openSimConnect).toHaveBeenCalledTimes(1))

    expect(statuses).toEqual([{ state: 'connecting' }, { state: 'connected', simConnectVersion: '12.2' }])
    expect(handle.addToDataDefinition).toHaveBeenCalled()
    expect(handle.requestDataOnSimObject).toHaveBeenCalled()
    expect(service.getStatus()).toEqual({ state: 'connected', simConnectVersion: '12.2' })

    handle.emit('simObjectData', { requestID: 0, data: fakeRawBuffer() })

    expect(telemetry).toHaveLength(1)
    expect(telemetry[0].title).toBe('Test Aircraft')
    expect(telemetry[0].onGround).toBe(true)
    expect(service.getLastTelemetry()).toEqual(telemetry[0])

    service.stop()
  })

  it('subscribes to the Pause system event and forwards it', async () => {
    const handle = fakeHandle()
    const openSimConnect = vi.fn(async () => ({
      recvOpen: { simConnectVersionMajor: 12, simConnectVersionMinor: 2 },
      handle
    })) as unknown as OpenSimConnect

    const service = new SimConnectService(openSimConnect)
    const paused: boolean[] = []
    service.on('paused', (p) => paused.push(p))

    service.start()
    await vi.waitFor(() => expect(handle.subscribeToSystemEvent).toHaveBeenCalled())

    handle.emit('event', { clientEventId: 1, data: 1 })
    handle.emit('event', { clientEventId: 1, data: 0 })
    handle.emit('event', { clientEventId: 999, data: 1 }) // unrelated event, ignored

    expect(paused).toEqual([true, false])
    service.stop()
  })

  it('retries with backoff when the sim is not running, and stops retrying once stopped', async () => {
    const openSimConnect = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })

    const service = new SimConnectService(openSimConnect as unknown as OpenSimConnect)
    service.start()
    await vi.waitFor(() => expect(openSimConnect).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(2_000)
    expect(openSimConnect).toHaveBeenCalledTimes(2)

    service.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(openSimConnect).toHaveBeenCalledTimes(2)
  })

  it('reconnects automatically if the sim quits', async () => {
    const firstHandle = fakeHandle()
    const secondHandle = fakeHandle()
    const openSimConnect = vi
      .fn()
      .mockResolvedValueOnce({
        recvOpen: { simConnectVersionMajor: 12, simConnectVersionMinor: 2 },
        handle: firstHandle
      })
      .mockResolvedValueOnce({
        recvOpen: { simConnectVersionMajor: 12, simConnectVersionMinor: 2 },
        handle: secondHandle
      }) as unknown as OpenSimConnect

    const service = new SimConnectService(openSimConnect)
    const statuses: SimConnectionStatus[] = []
    service.on('status', (status) => statuses.push(status))

    service.start()
    await vi.waitFor(() => expect(openSimConnect).toHaveBeenCalledTimes(1))

    firstHandle.emit('quit')
    expect(statuses.at(-1)).toEqual({ state: 'disconnected' })

    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(openSimConnect).toHaveBeenCalledTimes(2))
    expect(statuses.at(-1)).toEqual({ state: 'connected', simConnectVersion: '12.2' })

    service.stop()
  })
})

describe('SimConnectService high-rate touchdown severity (v1.2 Part 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function connectedService(): Promise<{
    service: SimConnectService
    handle: ReturnType<typeof fakeHandle>
  }> {
    const handle = fakeHandle()
    const openSimConnect = vi.fn(async () => ({
      recvOpen: { simConnectVersionMajor: 12, simConnectVersionMinor: 2 },
      handle
    })) as unknown as OpenSimConnect
    const service = new SimConnectService(openSimConnect)
    service.start()
    await vi.waitFor(() => expect(openSimConnect).toHaveBeenCalledTimes(1))
    return { service, handle }
  }

  function emitBaseline(handle: ReturnType<typeof fakeHandle>, overrides: Partial<SimTelemetry>): void {
    handle.emit('simObjectData', { requestID: 0, data: fakeTelemetryBuffer(overrides) })
  }

  function emitHighRate(handle: ReturnType<typeof fakeHandle>, verticalSpeedMs: number, onGround: boolean): void {
    handle.emit('simObjectData', { requestID: 1, data: fakeHighRateBuffer(verticalSpeedMs, onGround) })
  }

  function highRateCalls(handle: ReturnType<typeof fakeHandle>): unknown[][] {
    return (handle.requestDataOnSimObject as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (call) => call[0] === 1
    )
  }

  it('arms the high-rate stream once genuinely airborne and below the trigger altitude — not from the altitude band alone', async () => {
    const { handle } = await connectedService()

    // Still on the ground (a small positive AGL reading, e.g. taxiing/rolling) — the third
    // real-run bug (docs/simconnect-notes.md, 2026-09-20): AGL alone is also true during the
    // takeoff roll, so arming must also require !onGround.
    emitBaseline(handle, { altitudeAglM: 0.05, onGround: true })
    expect(highRateCalls(handle)).toHaveLength(0)

    // Airborne, but still above the trigger altitude.
    emitBaseline(handle, { altitudeAglM: 600, onGround: false })
    expect(highRateCalls(handle)).toHaveLength(0)

    // Airborne and below the trigger altitude — arms.
    emitBaseline(handle, { altitudeAglM: 400, onGround: false })
    expect(highRateCalls(handle)).toEqual([
      [1, 1, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME]
    ])
  })

  it('computes the near-contact peak vertical speed and emits touchdownSeverity at the precise touchdown moment', async () => {
    const { service, handle } = await connectedService()
    const severities: TouchdownSeverity[] = []
    service.on('touchdownSeverity', (result) => severities.push(result))

    emitBaseline(handle, { altitudeAglM: 400, onGround: false }) // arms

    // A flare: a big early descent rate outside the near-contact window, decaying by the
    // time of contact — real shape found live, docs/simconnect-notes.md, 2026-09-20.
    emitHighRate(handle, -8, false)
    vi.advanceTimersByTime(1_500) // outside the 1s near-contact window by the time contact happens
    emitHighRate(handle, -4, false)
    vi.advanceTimersByTime(500)
    emitHighRate(handle, -2.5, false) // the real peak within the last 1s before contact
    vi.advanceTimersByTime(400)
    emitHighRate(handle, -1, false)
    vi.advanceTimersByTime(400)
    emitHighRate(handle, -0.5, true) // ground contact

    expect(severities).toEqual([{ verticalSpeedMs: -2.5 }])
  })

  it('stops the high-rate stream a fixed delay after touchdown, and requires a genuine liftoff (past a small AGL margin) before re-arming', async () => {
    const { handle } = await connectedService()

    emitBaseline(handle, { altitudeAglM: 400, onGround: false }) // arms
    emitHighRate(handle, -3, false)
    emitHighRate(handle, -0.5, true) // touchdown

    // Not stopped yet — still within the post-touchdown window.
    vi.advanceTimersByTime(4_000)
    emitHighRate(handle, 0, true)
    expect(highRateCalls(handle).filter((call) => call[3] === SimConnectPeriod.NEVER)).toHaveLength(0)

    // Past the post-touchdown window — the next tick stops it.
    vi.advanceTimersByTime(1_500)
    emitHighRate(handle, 0, true)
    expect(highRateCalls(handle).filter((call) => call[3] === SimConnectPeriod.NEVER)).toHaveLength(1)

    // Taxi noise: onGround flickers false then true again without ever clearing a real
    // altitude margin — must not look like a departure (third real-run bug).
    emitBaseline(handle, { altitudeAglM: 0.5, onGround: false })
    emitBaseline(handle, { altitudeAglM: 0.1, onGround: true })
    emitBaseline(handle, { altitudeAglM: 0.05, onGround: false })
    emitBaseline(handle, { altitudeAglM: 0.05, onGround: true })
    expect(highRateCalls(handle).filter((call) => call[3] === SimConnectPeriod.SIM_FRAME)).toHaveLength(1)

    // A genuine liftoff — clears the AGL margin — re-arms for the next approach.
    emitBaseline(handle, { altitudeAglM: 10, onGround: false })
    emitBaseline(handle, { altitudeAglM: 400, onGround: false })
    expect(highRateCalls(handle).filter((call) => call[3] === SimConnectPeriod.SIM_FRAME)).toHaveLength(2)
  })
})
