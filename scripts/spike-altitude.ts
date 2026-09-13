/**
 * M1/M6 throwaway spike (CLAUDE.md's spike-first discipline) for
 * flightdeck-backend/docs/plans/logbook-detail-improvements.md Phase 3, Step 1(b).
 *
 * The chart plots PLANE ALTITUDE (true altitude), which reads high vs. the PFD in cruise
 * because the PFD shows pressure altitude above the transition altitude. This spike proves,
 * against a real running MSFS 2024, before any production code:
 *
 * 1. That PRESSURE ALTITUDE exists as a real SimVar and reads in meters (assumed from SDK
 *    docs only, never requested live).
 * 2. Whether PRESSURE ALTITUDE matches the PFD's displayed flight level in cruise.
 * 3. How far PLANE ALTITUDE (true) sits above PRESSURE ALTITUDE, and whether that gap is
 *    explained by AMBIENT TEMPERATURE vs. STANDARD ATM TEMPERATURE, by KOHLSMAN SETTING
 *    MB:1 / SEA LEVEL PRESSURE being above 1013.25, or both.
 *
 * INDICATED ALTITUDE is sampled only to understand the old -13,500 ft reading
 * (docs/decisions.md) — it isn't a candidate for use.
 *
 * Each SimVar gets its OWN data definition and request (the SIM RATE lesson,
 * docs/simconnect-notes.md 2026-09-06): if one name is wrong, only that one field is
 * missing from the printed snapshot instead of corrupting every read.
 *
 * Usage: npm run spike:altitude
 * (SIMCONNECT_HOST/SIMCONNECT_PORT env vars for a remote sim — see spike-simconnect.ts.)
 *
 * No manual labelling needed — this run is driven unattended (piped through a filter that
 * watches for MILESTONE lines), so the script detects phases itself from SIM ON GROUND and
 * altitude trends: on-runway baseline at startup, takeoff, climbing through the transition
 * altitude (~18,000 ft, TRANSITION_ALT_FT below), cruise stabilizing, and landing. Every
 * sample (not just milestones) still prints as a plain JSON line, so the full trace can be
 * recovered from wherever stdout was captured. Findings go in docs/simconnect-notes.md and
 * simbrief-notes.md (transition-altitude field names from a real OFP) in flightdeck-backend.
 */
import { appendFileSync } from 'node:fs'
import { open, Protocol, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type RawBuffer } from 'node-simconnect'

const APP_NAME = 'WingLog altitude spike'
// Every 2s tick is appended here regardless of milestones, so the exact numbers around a
// manual altimeter-setting change (or anything else) can be recovered after the fact even
// though only MILESTONE lines are noisy enough to print to stdout.
const TRACE_FILE = process.env['SPIKE_ALTITUDE_TRACE'] ?? 'spike-altitude-trace.jsonl'
const TRANSITION_ALT_FT = 18_000
const CRUISE_STABLE_WINDOW_MS = 45_000
const CRUISE_STABLE_RANGE_FT = 150
const CRUISE_REMINDER_INTERVAL_MS = 120_000

interface SimVarSpec {
  key: string
  name: string
  unit: string
  dataType: SimConnectDataType
  read: (data: RawBuffer) => number
}

// One data definition + request per var, numbered 0..7 — see the SIM RATE lesson above.
const SIM_VARS: SimVarSpec[] = [
  { key: 'onGround', name: 'SIM ON GROUND', unit: 'bool', dataType: SimConnectDataType.INT32, read: (d) => d.readInt32() },
  { key: 'trueAltFt', name: 'PLANE ALTITUDE', unit: 'feet', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'indicatedAltFt', name: 'INDICATED ALTITUDE', unit: 'feet', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'pressureAltFt', name: 'PRESSURE ALTITUDE', unit: 'feet', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'kohlsmanMb', name: 'KOHLSMAN SETTING MB:1', unit: 'millibars', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'seaLevelPressureMb', name: 'SEA LEVEL PRESSURE', unit: 'millibars', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'ambientTempC', name: 'AMBIENT TEMPERATURE', unit: 'celsius', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() },
  { key: 'standardTempC', name: 'STANDARD ATM TEMPERATURE', unit: 'celsius', dataType: SimConnectDataType.FLOAT64, read: (d) => d.readFloat64() }
]

function connectionOptions(): { remote: { host: string; port: number } } | undefined {
  const host = process.env['SIMCONNECT_HOST']
  const port = process.env['SIMCONNECT_PORT']
  if (!host || !port) return undefined
  return { remote: { host, port: Number(port) } }
}

open(APP_NAME, Protocol.SunRise, connectionOptions())
  .then(({ recvOpen, handle }) => {
    console.log(
      `Connected: ${recvOpen.applicationName} (SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`
    )

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

    // docs/simconnect-notes.md (2026-09-06): recvException.index is a parameter-slot index
    // into the specific SimConnect call, not a position in SIM_VARS — don't trust it to name
    // the failing var directly. Each var already has its own isolated definition/request
    // here, so the reliable way to identify it is: whichever key never shows up in a
    // snapshot once flying starts is the one that failed.
    handle.on('exception', (recvException) => {
      console.error(
        `SimConnect exception: ${recvException.exceptionName} (index ${recvException.index}, sendId ${recvException.sendId}). ` +
          'Each SimVar is isolated in its own definition — check which key stays undefined below to identify it.'
      )
    })

    function snapshot(): Record<string, unknown> {
      const gap =
        latest['trueAltFt'] != null && latest['pressureAltFt'] != null
          ? Math.round(latest['trueAltFt'] - latest['pressureAltFt'])
          : null
      const tempDevC =
        latest['ambientTempC'] != null && latest['standardTempC'] != null
          ? Math.round(latest['ambientTempC'] - latest['standardTempC'])
          : null
      return { ts: new Date().toISOString(), ...latest, onGround: latest['onGround'] === 1, gapTrueMinusPressureFt: gap, tempDevC }
    }

    // Phase-detection state, driven off the 1s sample tick below rather than each
    // individual SimVar's own async event — good enough for milestone timing, not for
    // precise cross-var correlation (see the plan's own "up to one second late" caveat
    // about this class of thing).
    let wasOnGround: boolean | null = null
    let taCrossed = false
    let cruiseAnnounced = false
    let lastCruiseReminder = 0
    let prevKohlsmanMb: number | null = null
    const altHistory: { t: number; alt: number }[] = []

    function milestone(tag: string, extra: Record<string, unknown> = {}): void {
      console.log(JSON.stringify({ milestone: tag, ...snapshot(), ...extra }))
    }

    let firstTick = true
    setInterval(() => {
      if (latest['onGround'] === undefined || latest['trueAltFt'] === undefined) return
      const onGround = latest['onGround'] === 1
      const trueAlt = latest['trueAltFt'] as number
      const climbAlt = latest['pressureAltFt'] ?? trueAlt

      if (firstTick) {
        firstTick = false
        wasOnGround = onGround
        milestone(onGround ? 'START (on runway)' : 'START (already airborne)')
      }

      if (wasOnGround !== null && wasOnGround !== onGround) {
        milestone(onGround ? 'LANDED' : 'TAKEOFF')
        if (!onGround) {
          // Reset climb/cruise detection for this new airborne segment (handles touch-and-goes).
          taCrossed = false
          cruiseAnnounced = false
          altHistory.length = 0
        }
      }
      wasOnGround = onGround

      // Catches a manual altimeter-setting change (e.g. swapping to STD at the pilot's own
      // chosen altitude) regardless of exactly when it happens — a real knob move, not
      // sensor noise, so the threshold is small.
      const kohlsman = latest['kohlsmanMb']
      if (kohlsman !== undefined) {
        if (prevKohlsmanMb !== null && Math.abs(kohlsman - prevKohlsmanMb) > 0.15) {
          milestone('ALTIMETER SETTING CHANGED', { fromMb: prevKohlsmanMb, toMb: kohlsman })
        }
        prevKohlsmanMb = kohlsman
      }

      if (!onGround && !taCrossed && climbAlt >= TRANSITION_ALT_FT) {
        taCrossed = true
        milestone(`CLIMBING THROUGH TRANSITION ALTITUDE (~${TRANSITION_ALT_FT} ft)`)
      }

      if (!onGround) {
        const now = Date.now()
        altHistory.push({ t: now, alt: trueAlt })
        while (altHistory.length > 0 && now - altHistory[0].t > CRUISE_STABLE_WINDOW_MS) altHistory.shift()
        const spanMs = altHistory.length > 1 ? now - altHistory[0].t : 0
        if (spanMs >= CRUISE_STABLE_WINDOW_MS) {
          const alts = altHistory.map((p) => p.alt)
          const range = Math.max(...alts) - Math.min(...alts)
          if (range <= CRUISE_STABLE_RANGE_FT && trueAlt > 10_000) {
            if (!cruiseAnnounced) {
              cruiseAnnounced = true
              lastCruiseReminder = now
              milestone('CRUISE STABLE')
            } else if (now - lastCruiseReminder >= CRUISE_REMINDER_INTERVAL_MS) {
              lastCruiseReminder = now
              milestone('CRUISE UPDATE')
            }
          } else if (range > CRUISE_STABLE_RANGE_FT) {
            cruiseAnnounced = false
          }
        }
      } else {
        altHistory.length = 0
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
