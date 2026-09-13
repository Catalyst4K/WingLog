/**
 * Ephemeral observability aid for this session's combined live-sim test of
 * flightdeck-backend's `navdata-without-navigraph.md` Phase 5 (crash-recovery resume prompt
 * on a genuinely 'active' flight) and `resume-track-cleanup.md` (the hold-detection false-
 * positive case). Not a spike answering an unknown-SimConnect-behaviour question the way
 * spike-altitude.ts/spike-landing.ts are — this is a second, independent SimConnect
 * connection that keeps recording position/ground-track regardless of whether WingLog itself
 * gets force-killed and relaunched, so there's an unbroken trace to cross-check WingLog's own
 * `track_point` rows against afterward (in particular: did telemetry really continue
 * uninterrupted through the crash, and roughly when did a holding pattern happen).
 *
 * Usage: npm run spike:live-position
 * (SIMCONNECT_HOST/SIMCONNECT_PORT env vars for a remote sim — see spike-simconnect.ts.)
 */
import { appendFileSync } from 'node:fs'
import { open, Protocol, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type RawBuffer } from 'node-simconnect'

const APP_NAME = 'WingLog live-position watcher'
const TRACE_FILE = process.env['SPIKE_POSITION_TRACE'] ?? 'spike-live-position-trace.jsonl'
const HOLD_WINDOW_MS = 4 * 60_000
const HOLD_TURN_THRESHOLD_DEG = 500
const HOLD_REMINDER_INTERVAL_MS = 120_000

interface SimVarSpec {
  key: string
  name: string
  unit: string
  dataType: SimConnectDataType
  read: (data: RawBuffer) => number
}

const SIM_VARS: SimVarSpec[] = [
  { key: 'onGround', name: 'SIM ON GROUND', unit: 'bool', dataType: SimConnectDataType.INT32, read: (d) => d.readInt32() },
  { key: 'lat', name: 'PLANE LATITUDE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'lon', name: 'PLANE LONGITUDE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'headingTrueDeg', name: 'PLANE HEADING DEGREES TRUE', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'altFt', name: 'PLANE ALTITUDE', unit: 'feet', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'groundSpeedKt', name: 'GROUND VELOCITY', unit: 'knots', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() }
]

function connectionOptions(): { remote: { host: string; port: number } } | undefined {
  const host = process.env['SIMCONNECT_HOST']
  const port = process.env['SIMCONNECT_PORT']
  if (!host || !port) return undefined
  return { remote: { host, port: Number(port) } }
}

function headingDeltaDeg(from: number, to: number): number {
  let d = to - from
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

open(APP_NAME, Protocol.SunRise, connectionOptions())
  .then(({ recvOpen, handle }) => {
    console.log(`Connected: ${recvOpen.applicationName} (SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`)

    const latest: Record<string, number | undefined> = {}
    SIM_VARS.forEach((spec, index) => {
      handle.addToDataDefinition(index, spec.name, spec.unit, spec.dataType, 0, 0)
      handle.requestDataOnSimObject(index, index, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND)
    })

    handle.on('simObjectData', (recvSimObjectData) => {
      const spec = SIM_VARS[recvSimObjectData.requestID]
      if (!spec) return
      latest[spec.key] = spec.read(recvSimObjectData.data)
    })

    handle.on('exception', (recvException) => {
      console.error(
        `SimConnect exception: ${recvException.exceptionName} (index ${recvException.index}, sendId ${recvException.sendId}).`
      )
    })

    function snapshot(): Record<string, unknown> {
      return { ts: new Date().toISOString(), ...latest, onGround: latest['onGround'] === 1 }
    }

    function milestone(tag: string, extra: Record<string, unknown> = {}): void {
      console.log(JSON.stringify({ milestone: tag, ...snapshot(), ...extra }))
    }

    let wasOnGround: boolean | null = null
    let firstTick = true
    let holdAnnounced = false
    let lastHoldReminder = 0
    const headingHistory: { t: number; heading: number }[] = []
    let cumulativeTurn = 0

    setInterval(() => {
      if (latest['onGround'] === undefined || latest['headingTrueDeg'] === undefined) return
      const onGround = latest['onGround'] === 1
      const heading = latest['headingTrueDeg'] as number
      const now = Date.now()

      if (firstTick) {
        firstTick = false
        wasOnGround = onGround
        milestone(onGround ? 'START (on ground)' : 'START (airborne)')
      }

      if (wasOnGround !== null && wasOnGround !== onGround) {
        milestone(onGround ? 'LANDED' : 'TAKEOFF')
        headingHistory.length = 0
        cumulativeTurn = 0
        holdAnnounced = false
      }
      wasOnGround = onGround

      if (!onGround) {
        if (headingHistory.length > 0) {
          const last = headingHistory[headingHistory.length - 1]
          cumulativeTurn += Math.abs(headingDeltaDeg(last.heading, heading))
        }
        headingHistory.push({ t: now, heading })
        while (headingHistory.length > 0 && now - headingHistory[0].t > HOLD_WINDOW_MS) {
          const dropped = headingHistory.shift()
          const next = headingHistory[0]
          if (dropped && next) cumulativeTurn -= Math.abs(headingDeltaDeg(dropped.heading, next.heading))
        }

        if (cumulativeTurn >= HOLD_TURN_THRESHOLD_DEG) {
          if (!holdAnnounced) {
            holdAnnounced = true
            lastHoldReminder = now
            milestone('POSSIBLE HOLD (sustained turning)', { cumulativeTurnDeg: Math.round(cumulativeTurn) })
          } else if (now - lastHoldReminder >= HOLD_REMINDER_INTERVAL_MS) {
            lastHoldReminder = now
            milestone('POSSIBLE HOLD (continuing)', { cumulativeTurnDeg: Math.round(cumulativeTurn) })
          }
        } else if (holdAnnounced && cumulativeTurn < HOLD_TURN_THRESHOLD_DEG / 2) {
          holdAnnounced = false
        }
      } else {
        headingHistory.length = 0
        cumulativeTurn = 0
      }

      appendFileSync(TRACE_FILE, JSON.stringify(snapshot()) + '\n')
    }, 2_000)

    process.on('SIGINT', () => {
      console.log('Shutting down.')
      handle.close()
      process.exit(0)
    })
  })
  .catch((error: unknown) => {
    console.error('Connection failed:', error)
    process.exit(1)
  })
