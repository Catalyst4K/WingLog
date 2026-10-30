/**
 * Knowing the pilot is online, replayed along a recorded flight (winglog-backend docs/plans/vatsim-build.md, Step 2): the real polling
 * rules (feed-poll-step.ts) and the real detection (self-status.ts) run over a flight's own track against an invented feed in which the
 * pilot's aircraft follows the track, 3 s behind. It reports when WingLog first knows the pilot is online, when BeyondATC would be
 * hidden, when the flight would be marked as flown online, and how many requests the feed would have got. Set WINGLOG_SIM_CAPTURE to use
 * another capture; by default the committed VHHH hop. The feed is invented: no real pilot is involved.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SimTelemetry } from '../../src/shared/ipc'
import { FEED_FLOOR_MS, initialPollState, pollFinished, stepPoll } from '../../src/main/online/feed-poll-step'
import type { FeedPilot, FeedSnapshot } from '../../src/main/online/feed-snapshot'
import { selfStatus, type SelfStatusInput } from '../../src/main/online/self-status'
import { parseFlightFixture } from '../../src/main/sim/flight-fixture'
import { simOutputDir, writeReport } from './report'
import { boundsOf, escapeHtml, makeFrame, polyline, svg, type LonLat } from './svg'

const FIXTURE = join('src', 'main', 'tracking', '__fixtures__', 'tier2-vfr-no-ofp-short-hop.ndjson')
const CID = '1234567'
const CALLSIGN = 'TSTPIL1'
const FEED_LAG_S = 3
const ONLINE_COLOUR = '#2f9e44'
const OFFLINE_COLOUR = '#868e96'

interface Run {
  label: string
  firstOnlineS: number | null
  hiddenFromS: number | null
  markedFlownOnlineS: number | null
  requests: number
  shortestGapS: number | null
  trackOnline: LonLat[]
  trackBefore: LonLat[]
}

/** The invented feed at one moment: the pilot's aircraft where the track was FEED_LAG_S ago, with the plan filed for the flight. */
function feedAt(
  telemetry: SimTelemetry,
  nowMs: number,
  plan: { departure: string; arrival: string }
): FeedSnapshot {
  const own: FeedPilot = {
    memberId: CID,
    callsign: CALLSIGN,
    latitude: telemetry.latitude,
    longitude: telemetry.longitude,
    altitudeM: telemetry.altitudeM,
    groundSpeedMs: telemetry.groundSpeedMs,
    headingDeg: telemetry.headingTrueDeg,
    onGround: telemetry.onGround,
    aircraftIcao: 'C172',
    departure: plan.departure,
    arrival: plan.arrival,
    ageAtFeedS: FEED_LAG_S
  }
  return { network: 'vatsim', updatedMs: nowMs, receivedMs: nowMs, pilots: [own], controllers: [], atis: [] }
}

function run(
  label: string,
  telemetry: { tOffsetMs: number; data: SimTelemetry }[],
  memberId: string | null,
  plan: { departure: string; arrival: string }
): Run {
  const result: Run = {
    label,
    firstOnlineS: null,
    hiddenFromS: null,
    markedFlownOnlineS: null,
    requests: 0,
    shortestGapS: null,
    trackOnline: [],
    trackBefore: []
  }
  let poll = initialPollState()
  let snapshot: FeedSnapshot | null = null
  let lastStart: number | null = null
  for (const { tOffsetMs, data } of telemetry) {
    const step = stepPoll(poll, { nowMs: tOffsetMs, network: 'vatsim', wanted: 'status' })
    poll = step.state
    if (step.fetchNow) {
      result.requests++
      if (lastStart !== null) {
        const gap = (tOffsetMs - lastStart) / 1000
        result.shortestGapS = Math.min(result.shortestGapS ?? gap, gap)
      }
      lastStart = tOffsetMs
      snapshot = feedAt(data, tOffsetMs, plan)
      poll = pollFinished(poll, true, tOffsetMs)
    }
    const input: SelfStatusInput = {
      network: 'vatsim',
      memberId,
      flight: plan,
      position: { lat: data.latitude, lon: data.longitude },
      pretendCallsign: null,
      keepBeyondAtc: false
    }
    const { status } = selfStatus(snapshot, input)
    const online = status.state === 'online' || status.state === 'probably'
    const at = Math.round(tOffsetMs / 1000)
    if (online && result.firstOnlineS === null) result.firstOnlineS = at
    if (status.hidesBeyondAtc && result.hiddenFromS === null) result.hiddenFromS = at
    if (online && !data.onGround && result.markedFlownOnlineS === null) result.markedFlownOnlineS = at
    const point: LonLat = [data.longitude, data.latitude]
    ;(online ? result.trackOnline : result.trackBefore).push(point)
  }
  return result
}

const seconds = (s: number | null): string => (s === null ? 'never' : `${s} s`)

it('simulates knowing the pilot is online along a recorded flight', () => {
  const path = process.env.WINGLOG_SIM_CAPTURE ?? FIXTURE
  const capture = parseFlightFixture(readFileSync(path, 'utf8'))
  const telemetry = capture.events.flatMap((e) =>
    e.type === 'telemetry' ? [{ tOffsetMs: e.tOffsetMs, data: e.data }] : []
  )
  const plan = { departure: 'VHHH', arrival: 'VMMC' }
  // With a CID the pilot is found wherever the aircraft is; without one only a filed plan near the aircraft finds them.
  const runs = [
    run('With the CID entered', telemetry, CID, plan),
    run('Without a CID (plan and position)', telemetry, null, plan)
  ]

  const all = [...runs[0]!.trackOnline, ...runs[0]!.trackBefore]
  const frame = makeFrame(boundsOf(all, 0.01), 420, 260, 420)
  const sections = runs.map((r) => ({
    title: r.label,
    meta: `Status looked up every 60 s while the flight is tracked; the invented feed follows the track ${FEED_LAG_S} s behind.`,
    metrics: [
      { label: 'First knew the pilot is online', value: seconds(r.firstOnlineS) },
      { label: 'BeyondATC hidden from', value: seconds(r.hiddenFromS) },
      { label: 'Flight marked as flown online at', value: seconds(r.markedFlownOnlineS) },
      { label: 'Requests to the feed', value: String(r.requests) },
      { label: 'Shortest gap between requests', value: r.shortestGapS === null ? '-' : `${r.shortestGapS} s` }
    ],
    figures: `<figure>${svg(
      frame,
      polyline(frame, r.trackBefore, `stroke="${OFFLINE_COLOUR}" stroke-width="3"`) +
        polyline(frame, r.trackOnline, `stroke="${ONLINE_COLOUR}" stroke-width="4"`),
      r.label
    )}<figcaption>${escapeHtml('Green: from when WingLog knew the pilot was online')}</figcaption></figure>`
  }))

  const page = writeReport(
    'online-status',
    {
      title: 'Knowing the pilot is online',
      intro: `A recorded flight (${capture.header.scenario}) replayed with the real polling rules and detection against an invented VATSIM feed.`,
      lookFor: [
        'With the CID, WingLog knows at the first look (the moment tracking starts), and BeyondATC is hidden from then.',
        'Without a CID, it knows only while the plan matches and the aircraft is within 5 nm of the feed position.',
        'The flight is marked as flown online at the first moment the pilot is online and airborne.',
        'Requests are at least 15 s apart (60 s here) however long the flight.'
      ],
      key: [
        { colour: OFFLINE_COLOUR, label: 'Before WingLog knew' },
        { colour: ONLINE_COLOUR, label: 'Online' }
      ],
      summary: runs.map((r) => ({
        label: r.label,
        value: `online at ${seconds(r.firstOnlineS)}, ${r.requests} requests`
      })),
      sections
    },
    { runs }
  )
  console.log(
    `Online status sim: ${runs.map((r) => `${r.label}: online at ${seconds(r.firstOnlineS)}`).join('; ')}; report ${page}`
  )

  for (const r of runs) {
    expect(r.firstOnlineS, r.label).not.toBeNull()
    expect(r.hiddenFromS, r.label).toBe(r.firstOnlineS)
    expect(r.markedFlownOnlineS, r.label).not.toBeNull()
    expect(r.shortestGapS ?? FEED_FLOOR_MS, r.label).toBeGreaterThanOrEqual(FEED_FLOOR_MS / 1000)
  }
})
void simOutputDir
