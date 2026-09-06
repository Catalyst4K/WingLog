/**
 * M6 throwaway spike (PLAN.md §6, CLAUDE.md M1/M6 rule) — the two things
 * docs/decisions.md's landing-analysis entry flags as genuinely unverified before the
 * production landing-capture code (src/main/tracking/landing-capture.ts) can trust
 * anything beyond the already-flowing 1 Hz telemetry it uses today:
 *
 * 1. Do MSFS 2024's dedicated touchdown SimVars (PLANE TOUCHDOWN NORMAL VELOCITY/PITCH
 *    DEGREES/BANK DEGREES) report sane values, and do they agree with the derived
 *    numbers (VERTICAL SPEED/PLANE PITCH DEGREES/PLANE BANK DEGREES) already sampled at
 *    the same 1 Hz tick? If they agree, prefer the sim's own numbers. If they're absent
 *    or nonsensical, that's the kind of finding this project has learned to check for.
 * 2. Is 1 Hz resolution actually good enough for a usable touchdown-rate figure, or does
 *    it diverge meaningfully from the dedicated SimVar on the same real landing?
 *
 * Run this during a real landing, then compare the two blocks it prints at the
 * SIM ON GROUND false->true transition. Log findings in docs/simconnect-notes.md, same as
 * every other spike here — and update landing-capture.ts's `touchdownSource` (currently
 * always 'derived') only once this has actually been run against a real flight.
 *
 * Usage: npm run spike:landing
 * (SIMCONNECT_HOST/SIMCONNECT_PORT env vars for a remote sim — see spike-simconnect.ts.)
 */
import { open, Protocol, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type RawBuffer } from 'node-simconnect'

const APP_NAME = 'WingLog landing spike'
const DEFINITION_ID = 0
const REQUEST_ID = 0

interface SimVarSpec {
  name: string
  unit: string | null
  dataType: SimConnectDataType
  read: (data: RawBuffer) => number | boolean
}

const asBool = (data: RawBuffer): boolean => data.readInt32() === 1

// Already-flowing telemetry (same names as simvars.ts) plus the three unverified
// dedicated touchdown vars, requested alongside it so both are sampled on the exact same
// tick for a fair comparison.
const SIM_VARS: SimVarSpec[] = [
  { name: 'SIM ON GROUND', unit: 'bool', dataType: SimConnectDataType.INT32, read: asBool },
  { name: 'VERTICAL SPEED', unit: 'feet/minute', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'PLANE PITCH DEGREES', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'PLANE BANK DEGREES', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  // Unverified — the whole point of this spike.
  {
    name: 'PLANE TOUCHDOWN NORMAL VELOCITY',
    unit: 'feet/minute',
    dataType: SimConnectDataType.FLOAT64,
    read: (d) => d.readFloat64()
  },
  { name: 'PLANE TOUCHDOWN PITCH DEGREES', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { name: 'PLANE TOUCHDOWN BANK DEGREES', unit: 'degrees', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() }
]

function connectionOptions(): { remote: { host: string; port: number } } | undefined {
  const host = process.env['SIMCONNECT_HOST']
  const port = process.env['SIMCONNECT_PORT']
  if (!host || !port) return undefined
  return { remote: { host, port: Number(port) } }
}

open(APP_NAME, Protocol.SunRise, connectionOptions())
  .then(({ recvOpen, handle }) => {
    console.log(`Connected: ${recvOpen.applicationName} (SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`)
    console.log('Waiting for a landing... (SIM ON GROUND false -> true transition)')

    for (const [index, spec] of SIM_VARS.entries()) {
      handle.addToDataDefinition(DEFINITION_ID, spec.name, spec.unit, spec.dataType, 0, index)
    }
    handle.requestDataOnSimObject(REQUEST_ID, DEFINITION_ID, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND)

    let wasOnGround = false

    handle.on('simObjectData', (recvSimObjectData) => {
      if (recvSimObjectData.requestID !== REQUEST_ID) return

      const values: Record<string, number | boolean> = {}
      for (const spec of SIM_VARS) values[spec.name] = spec.read(recvSimObjectData.data)

      const onGround = values['SIM ON GROUND'] as boolean
      if (onGround && !wasOnGround) {
        console.log('\n=== TOUCHDOWN ===')
        console.log('Derived (this tick, what landing-capture.ts uses today):')
        console.log({
          verticalSpeedFpm: values['VERTICAL SPEED'],
          pitchDeg: values['PLANE PITCH DEGREES'],
          bankDeg: values['PLANE BANK DEGREES']
        })
        console.log('Dedicated touchdown SimVars (unverified):')
        console.log({
          verticalSpeedFpm: values['PLANE TOUCHDOWN NORMAL VELOCITY'],
          pitchDeg: values['PLANE TOUCHDOWN PITCH DEGREES'],
          bankDeg: values['PLANE TOUCHDOWN BANK DEGREES']
        })
        console.log('=================\n')
      }
      wasOnGround = onGround
    })

    handle.on('exception', (recvException) => {
      console.error(`SimConnect exception: ${recvException.exceptionName} (index ${recvException.index}, sendId ${recvException.sendId})`)
      console.error('-> if this names one of the PLANE TOUCHDOWN vars, that answers question 1 on its own')
    })

    process.on('SIGINT', () => {
      console.log('\nShutting down.')
      handle.close()
      process.exit(0)
    })
  })
  .catch((error: unknown) => {
    console.error('Connection failed:', error)
    process.exit(1)
  })
