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
 *
 * v2, 2026-09-20, after the first live run found two bugs in this script (not in
 * SimConnect) — see docs/simconnect-notes.md's 2026-09-20 entry: the peak tracker now
 * resets on every fresh arming, re-arming now requires a genuine liftoff since the last
 * capture rather than just "AGL reads below the trigger" (which was also true while
 * parked, causing an infinite start/stop loop), and the peak is split into before- and
 * after-contact so a rollout bounce can't masquerade as touchdown severity.
 *
 * v3, same day, after Callum flagged what the first run's own "97 seconds before
 * touchdown" peak actually was: a real, single, continuous approach where he descended
 * unusually early and quickly, not a separate go-around. That means "peak anywhere below
 * 500m AGL" is itself the wrong window — a real approach can spend well over a minute
 * below that altitude with nothing to do with how hard the touchdown itself was. This
 * version keeps that whole-window figure only as context and adds the number that
 * actually matters: the peak within a short rolling buffer of the last few seconds
 * *before* ground contact, computed from the high-rate stream's own touchdown moment
 * (more precise than the baseline's 1 Hz one) rather than the whole armed window.
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
// The real window(s) worth comparing against today's single 1 Hz "previous tick" value —
// short enough that an early, unrelated steep-descent segment minutes before touchdown
// can't be included, per the 2026-09-20 real-flight finding above.
const NEAR_CONTACT_WINDOWS_MS = [1_000, 2_000, 5_000]
// How far back the rolling buffer keeps ticks — must cover the largest window above.
const RING_BUFFER_MS = Math.max(...NEAR_CONTACT_WINDOWS_MS)

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
    // Split so a rollout bounce/gear-rebound after contact (real physics, not noise, but a
    // different question from "how hard did it actually touch down") can't masquerade as
    // the pre-contact severity number scoring actually cares about. Whole-window figures —
    // kept as context only; per the 2026-09-20 finding, NOT the number that answers "how
    // hard did it touch down" on its own.
    let peakFpmPreTouchdown = 0
    let peakFpmPostTouchdown = 0
    // Rolling buffer of recent high-rate ticks, pruned to RING_BUFFER_MS — lets the actual
    // near-contact peak be computed retrospectively once the precise touchdown moment is
    // known, rather than needing to guess the window in advance.
    const ringBuffer: { t: number; fpm: number }[] = []
    let wasOnGroundHighRate = false
    // ms-precise touchdown moment from the high-rate stream itself (vs. touchdownAt below,
    // which is the baseline's own coarser 1 Hz detection, kept separately so
    // baselineFpmAtDetection still faithfully mimics today's exact production behaviour).
    let preciseTouchdownAt: number | null = null
    // The value production code would have used: the 1 Hz baseline tick immediately
    // before on-ground flips true (previousTelemetry, per landing-capture.ts's own doc
    // comment on why it uses the previous tick rather than the touchdown tick itself).
    let previousBaselineFpm: number | null = null
    let baselineFpmAtDetection: number | null = null
    let wasOnGroundBaseline = false
    // Bug found on the second live run (2026-09-20, docs/simconnect-notes.md): the script
    // was (re)started while already on the ground taxiing, and wasOnGroundBaseline/
    // previousBaselineFpm both default as if it always starts mid-air. That made the very
    // first-ever baseline tick (onGround already true) look like a fresh touchdown against
    // a previousBaselineFpm that had never been set — "undefined" — and armed the high-rate
    // stream with an empty ring buffer, hence the null/0 near-contact peaks. Seed state from
    // the first tick instead of evaluating transitions against it.
    let hasBaselineTick = false
    // Bug found on the first live run (2026-09-20, docs/simconnect-notes.md): without this
    // latch, sitting on the ground afterwards (AGL reads a low-but-nonzero value) kept
    // re-satisfying the arm condition below every baseline tick, restarting the high-rate
    // stream and re-triggering the "5s since touchdown" stop on every single tick forever.
    // Only true right after a real departure (onGround true -> false above the trigger
    // altitude); false again the moment a landing has been captured, until the next one.
    let awaitingLanding = true
    // Also found on the second live run: taxiing produced brief onGround/AGL flicker (bumps,
    // gear compression, tight turns) that read as a "genuine liftoff" and re-armed the whole
    // cycle while stationary on a taxiway. Require a real altitude margin, not just the
    // boolean, before treating it as an actual departure.
    const LIFTOFF_AGL_MARGIN_M = 3

    function startHighRate(): void {
      if (highRateActive) return
      highRateActive = true
      highRateStartedAt = Date.now()
      highRateTickCount = 0
      // Also found on the first run: an earlier low pass/go-around's peak survived,
      // unrelated, all the way to the real landing 97s later. Reset on every fresh arming.
      peakFpmHighRate = 0
      peakGHighRate = 0
      peakFpmPreTouchdown = 0
      peakFpmPostTouchdown = 0
      ringBuffer.length = 0
      wasOnGroundHighRate = false
      preciseTouchdownAt = null
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

        if (!hasBaselineTick) {
          hasBaselineTick = true
          wasOnGroundBaseline = onGround
          previousBaselineFpm = fpm
          return
        }

        if (!highRateActive && awaitingLanding && altAglM < HIGH_RATE_TRIGGER_AGL_M && altAglM > 0) startHighRate()

        if (!wasOnGroundBaseline && onGround) {
          touchdownAt = Date.now()
          baselineFpmAtDetection = previousBaselineFpm
          console.log(
            `Baseline touchdown detected. Previous-tick fpm (what production code uses today): ${previousBaselineFpm?.toFixed(0)}`
          )
        }
        // Genuinely airborne again (a real departure, a go-around, a touch-and-go's own
        // bounce back into the air) re-arms detection for the next approach — supports
        // multiple landings in one run, and means a go-around's own low pass before the
        // real landing gets its own, separate peak rather than contaminating the next one.
        // Requires a real altitude margin (not just the boolean) so taxi bumps/turns can't
        // masquerade as a departure — see LIFTOFF_AGL_MARGIN_M above.
        if (wasOnGroundBaseline && !onGround && altAglM > LIFTOFF_AGL_MARGIN_M) {
          awaitingLanding = true
          touchdownAt = null
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
        const now = Date.now()
        log('high-rate-tick', { fpm, onGround, gForce })

        ringBuffer.push({ t: now, fpm })
        while (ringBuffer.length > 0 && ringBuffer[0]!.t < now - RING_BUFFER_MS) ringBuffer.shift()

        // The precise moment, to the tick, that this stream itself saw ground contact —
        // independent of the baseline's own coarser 1 Hz detection (touchdownAt), which
        // exists only to faithfully reproduce what today's production code would compute.
        if (!wasOnGroundHighRate && onGround && preciseTouchdownAt === null) {
          preciseTouchdownAt = now
          const nearContact = Object.fromEntries(
            NEAR_CONTACT_WINDOWS_MS.map((windowMs) => {
              const inWindow = ringBuffer.filter((p) => p.t >= now - windowMs && p.t < now)
              const peak = inWindow.length > 0 ? Math.max(...inWindow.map((p) => Math.abs(p.fpm))) : null
              return [`last${windowMs}ms`, peak]
            })
          )
          console.log(`Precise touchdown. Peak fpm in the last N ms before contact: ${JSON.stringify(nearContact)}`)
          log('near-contact-peaks', nearContact)
        }
        wasOnGroundHighRate = onGround

        if (touchdownAt === null || now - touchdownAt < HIGH_RATE_STOP_AFTER_TOUCHDOWN_MS) {
          peakFpmHighRate = Math.max(peakFpmHighRate, Math.abs(fpm))
          peakGHighRate = Math.max(peakGHighRate, gForce)
          if (touchdownAt === null) peakFpmPreTouchdown = Math.max(peakFpmPreTouchdown, Math.abs(fpm))
          else peakFpmPostTouchdown = Math.max(peakFpmPostTouchdown, Math.abs(fpm))
        }
        if (touchdownAt !== null && now - touchdownAt >= HIGH_RATE_STOP_AFTER_TOUCHDOWN_MS) {
          stopHighRate()
          awaitingLanding = false // captured; don't re-arm until a real liftoff happens
          console.log(
            `Whole-window peak before contact (context only, spans the full sub-500m segment — ` +
              `see near-contact peaks above for the number that actually matters): ${peakFpmPreTouchdown.toFixed(0)}. ` +
              `After contact (rollout/bounce): ${peakFpmPostTouchdown.toFixed(0)} — ` +
              `vs. baseline's previous-tick: ${baselineFpmAtDetection?.toFixed(0)} — peak G: ${peakGHighRate.toFixed(2)}`
          )
          log('comparison', { peakFpmPreTouchdown, peakFpmPostTouchdown, baselineFpmAtDetection, peakGHighRate })
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
