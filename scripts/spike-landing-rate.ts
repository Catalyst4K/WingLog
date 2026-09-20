/**
 * Throwaway spike for flightdeck-backend docs/plans/landing-scoring-v2.md's "sampling
 * resolution near touchdown" idea, now scoped into v1.2 (docs/plans/v1-2.md, Part 3).
 *
 * Question this answers: can a SECOND, high-rate SimConnect request run alongside the
 * app's real 1 Hz telemetry stream, switched on only during the approach and off again
 * after touchdown, and what's its actual achieved rate (SIM_FRAME's Hz is not documented
 * as a fixed number — it depends on the sim's physics tick)? And does it actually capture
 * a materially different (higher-magnitude) peak vertical speed than the existing 1 Hz
 * "previous tick before on-ground" value landing-capture.ts uses today?
 *
 * Deliberately does NOT feed the high-rate samples into anything resembling
 * FlightRecorder/TrackingController's phase logic — that logic's sustain counters
 * (LEVEL_SUSTAIN_SAMPLES, DESCENT_SUSTAIN_SAMPLES, MIN_AIRBORNE_SAMPLES_FOR_NEW_TOUCHDOWN)
 * count *samples*, not seconds, so simply raising the main stream's rate would silently
 * break every one of those (a level streak "confirmed" in 0.1s instead of 10s, etc.) —
 * found by reading the real code before writing any of this, not guessed. The production
 * design this spike is derisking keeps the primary 1 Hz stream feeding the phase machine
 * exactly as today, and only reads the second, high-rate stream for the touchdown-severity
 * numbers themselves (vertical speed, g-force) in a short window around ground contact.
 *
 * Usage (MSFS running, fly a normal approach and landing):
 *   npm run spike:landing-rate
 * Log the answers in flightdeck-backend's docs/simconnect-notes.md before any production
 * code is written against this.
 */
import { appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { open, Protocol, SimConnectConstants, SimConnectDataType, SimConnectPeriod } from 'node-simconnect'

const LOG_FILE = join(mkdtempSync(join(tmpdir(), 'winglog-landing-rate-spike-')), 'output.jsonl')
console.log(`Logging every tick to ${LOG_FILE}`)
function log(kind: string, data: Record<string, unknown>): void {
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n')
}

const BASELINE_DEF = 0
const BASELINE_REQ = 0
const HIGH_RATE_DEF = 1
const HIGH_RATE_REQ = 1
// Matches FlightRecorder's own DESCENT_APPROACH_AGL_M — the altitude below which the real
// design would already be recording every 1 Hz point anyway, so switching to high-rate
// here doesn't cross into "changes what a normal descent looks like" territory.
const HIGH_RATE_TRIGGER_AGL_M = 500
// How long after touchdown to keep the high-rate stream running, to see the true rollout
// bounce/settle behaviour too, before switching back off.
const HIGH_RATE_STOP_AFTER_TOUCHDOWN_MS = 5_000

const M_PER_FT = 0.3048
const msToFpm = (ms: number): number => (ms / M_PER_FT) * 60

open('WingLog landing-rate spike', Protocol.SunRise)
  .then(({ recvOpen, handle }) => {
    console.log(`Connected: ${recvOpen.applicationName} (SimConnect ${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor})`)

    // Baseline: exactly what SimConnectService.ts requests today.
    handle.addToDataDefinition(BASELINE_DEF, 'PLANE ALT ABOVE GROUND', 'meters', SimConnectDataType.FLOAT64, 0, 0)
    handle.addToDataDefinition(BASELINE_DEF, 'VERTICAL SPEED', 'meters per second', SimConnectDataType.FLOAT64, 0, 1)
    handle.addToDataDefinition(BASELINE_DEF, 'SIM ON GROUND', 'bool', SimConnectDataType.INT32, 0, 2)
    handle.addToDataDefinition(BASELINE_DEF, 'G FORCE', 'GForce', SimConnectDataType.FLOAT64, 0, 3)
    handle.requestDataOnSimObject(BASELINE_REQ, BASELINE_DEF, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND)

    // High-rate: a separate, minimal definition — only what buildLandingRecord actually
    // needs for the two touchdown-severity inputs this spike is investigating.
    handle.addToDataDefinition(HIGH_RATE_DEF, 'VERTICAL SPEED', 'meters per second', SimConnectDataType.FLOAT64, 0, 0)
    handle.addToDataDefinition(HIGH_RATE_DEF, 'SIM ON GROUND', 'bool', SimConnectDataType.INT32, 0, 1)
    handle.addToDataDefinition(HIGH_RATE_DEF, 'G FORCE', 'GForce', SimConnectDataType.FLOAT64, 0, 2)

    let highRateActive = false
    let highRateStartedAt = 0
    let highRateTickCount = 0
    let touchdownAt: number | null = null
    let peakFpmHighRate = 0
    let peakGHighRate = 0
    // The value production code would have used: the 1 Hz baseline tick immediately
    // before on-ground flips true (previousTelemetry, per landing-capture.ts's own doc
    // comment on why it uses the previous tick rather than the touchdown tick itself).
    let previousBaselineFpm: number | null = null
    let baselineFpmAtDetection: number | null = null
    let wasOnGroundBaseline = false

    function startHighRate(): void {
      if (highRateActive) return
      highRateActive = true
      highRateStartedAt = Date.now()
      highRateTickCount = 0
      console.log('Starting high-rate stream (SIM_FRAME)...')
      handle.requestDataOnSimObject(HIGH_RATE_REQ, HIGH_RATE_DEF, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME)
    }

    function stopHighRate(): void {
      if (!highRateActive) return
      highRateActive = false
      const elapsedS = (Date.now() - highRateStartedAt) / 1000
      const achievedHz = highRateTickCount / elapsedS
      console.log(
        `Stopping high-rate stream. ${highRateTickCount} ticks in ${elapsedS.toFixed(1)}s = ${achievedHz.toFixed(1)} Hz achieved.`
      )
      log('high-rate-summary', { ticks: highRateTickCount, elapsedS, achievedHz })
      handle.requestDataOnSimObject(HIGH_RATE_REQ, HIGH_RATE_DEF, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.NEVER)
    }

    handle.on('simObjectData', (recv) => {
      if (recv.requestID === BASELINE_REQ) {
        const altAglM = recv.data.readFloat64()
        const verticalSpeedMs = recv.data.readFloat64()
        const onGround = recv.data.readInt32() === 1
        const gForce = recv.data.readFloat64()
        const fpm = msToFpm(verticalSpeedMs)
        log('baseline-tick', { altAglM, fpm, onGround, gForce })

        if (!highRateActive && altAglM < HIGH_RATE_TRIGGER_AGL_M && altAglM > 0) startHighRate()

        if (!wasOnGroundBaseline && onGround) {
          touchdownAt = Date.now()
          baselineFpmAtDetection = previousBaselineFpm
          console.log(
            `Baseline touchdown detected. Previous-tick fpm (what production code uses today): ${previousBaselineFpm?.toFixed(0)}`
          )
        }
        wasOnGroundBaseline = onGround
        previousBaselineFpm = fpm
        return
      }
      if (recv.requestID === HIGH_RATE_REQ) {
        highRateTickCount++
        const verticalSpeedMs = recv.data.readFloat64()
        const onGround = recv.data.readInt32() === 1
        const gForce = recv.data.readFloat64()
        const fpm = msToFpm(verticalSpeedMs)
        log('high-rate-tick', { fpm, onGround, gForce })
        if (touchdownAt === null || Date.now() - touchdownAt < HIGH_RATE_STOP_AFTER_TOUCHDOWN_MS) {
          peakFpmHighRate = Math.max(peakFpmHighRate, Math.abs(fpm))
          peakGHighRate = Math.max(peakGHighRate, gForce)
        }
        if (touchdownAt !== null && Date.now() - touchdownAt >= HIGH_RATE_STOP_AFTER_TOUCHDOWN_MS) {
          stopHighRate()
          console.log(
            `Peak high-rate fpm around touchdown: ${peakFpmHighRate.toFixed(0)} (vs. baseline's ${baselineFpmAtDetection?.toFixed(0)}) — ` +
              `peak G: ${peakGHighRate.toFixed(2)}`
          )
          log('comparison', { peakFpmHighRate, baselineFpmAtDetection, peakGHighRate })
        }
      }
    })

    handle.on('exception', (e) => {
      console.error(`SimConnect exception: ${e.exceptionName} (index ${e.index})`)
      log('exception', { exceptionName: e.exceptionName, index: e.index })
    })
    handle.on('quit', () => process.exit(0))
    process.on('SIGINT', () => {
      console.log(`\nShutting down. Full log: ${LOG_FILE}`)
      handle.close()
      process.exit(0)
    })
  })
  .catch((error: unknown) => {
    console.error('Connection failed:', error)
    process.exit(1)
  })
