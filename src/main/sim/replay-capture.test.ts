import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BeyondAtcService } from '../beyondatc/BeyondAtcService'
import { GsxRemoteService } from '../gsx-remote/GsxRemoteService'
import { parseFlightFixture, type FlightFixtureEvent, type ParsedFlightFixture } from './flight-fixture'
import { replayCapture, ReplaySocketLink } from './replay-capture'

const EGLL = parseFlightFixture(
  readFileSync(
    new URL('../tracking/__fixtures__/short-hop-egll-egcc.ndjson', import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      '$1'
    ),
    'utf8'
  )
)
const CAPTURED_AT = '2026-10-05T15:53:00.000Z'

// Real lines: ZJSY arrival InfoBoxes (BeyondATC, 2026-10-05) and GSX's airport/parking keys.
const STAR_BOXES = 'InfoBoxes: [{"title":"STAR","info":"UPRS2C"},{"title":"Arrival Runway","info":"08"}]'
const LANDING_BOXES = 'InfoBoxes: [{"title":"Landing Runway","info":"08"},{"title":"QNH","info":"QNH 1014"}]'
const GSX_SNAPSHOT = JSON.stringify({
  v: 1,
  type: 'snapshot',
  ts: 1,
  services: [],
  airport: { icao: 'VHHH', name: 'Hong Kong Intl', country: 'HK' },
  parking: '(N) T1 North|Gate N6',
  gateProperties: []
})

/** The EGLL fixture's first ticks, one second apart, with captured lines mixed in. */
function capture(lines: FlightFixtureEvent[]): ParsedFlightFixture {
  const ticks = EGLL.events.filter((e) => e.type === 'telemetry').slice(0, 6)
  const telemetry = ticks.map((e, i) => ({ ...e, tOffsetMs: i * 1000 }))
  const events = [...telemetry, ...lines].sort((a, b) => a.tOffsetMs - b.tOffsetMs)
  return { header: { ...EGLL.header, scenario: 'replay-capture test', capturedAt: CAPTURED_AT }, events }
}

function finished(replay: ReturnType<typeof replayCapture>): Promise<void> {
  return new Promise((resolve) => replay.sim.on('replayComplete', resolve))
}

/** Lets the replay sockets open before the first event. */
function opened(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('replayCapture', () => {
  it('feeds captured BeyondATC and GSX lines to the real services, in step with the sim', async () => {
    const replay = replayCapture(
      capture([
        { type: 'beyondatc', tOffsetMs: 1500, direction: 'in', text: STAR_BOXES },
        { type: 'beyondatc', tOffsetMs: 2000, direction: 'out', text: 'frequencies' },
        { type: 'gsx', tOffsetMs: 2500, direction: 'in', text: GSX_SNAPSHOT },
        { type: 'beyondatc', tOffsetMs: 3500, direction: 'in', text: LANDING_BOXES }
      ])
    )
    const beyondAtc = new BeyondAtcService('replay', 0, replay.beyondAtc.socketCtor)
    const gsx = new GsxRemoteService('replay', 0, replay.gsx.socketCtor)
    const boxesWhenTicked: string[] = []
    replay.sim.on('telemetry', () =>
      boxesWhenTicked.push(
        beyondAtc
          .getState()
          .infoBoxes.map((b) => b.info)
          .join(',')
      )
    )
    beyondAtc.start()
    gsx.start()
    await opened()

    const done = finished(replay)
    replay.sim.start()
    await done

    // Ticks at 0-5 s; the STAR boxes arrive at 1.5 s, the landing boxes at 3.5 s.
    expect(boxesWhenTicked).toEqual(['', '', 'UPRS2C,08', 'UPRS2C,08', '08,QNH 1014', '08,QNH 1014'])
    expect(gsx.getGateInfo()).toMatchObject({ airportIcao: 'VHHH', parking: '(N) T1 North|Gate N6' })
    // What WingLog sent during the recording isn't replayed; what it sends now is collected.
    expect(replay.beyondAtc.sent).toEqual(['frequencies'])
    expect(replay.beyondAtc.dropped).toEqual([])
    beyondAtc.stop()
    gsx.stop()
  })

  it('keeps the clock at the recorded moment of each event', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const replay = replayCapture(
      capture([{ type: 'beyondatc', tOffsetMs: 2500, direction: 'in', text: STAR_BOXES }]),
      {
        setClock: (epochMs) => vi.setSystemTime(epochMs)
      }
    )
    const beyondAtc = new BeyondAtcService('replay', 0, replay.beyondAtc.socketCtor)
    beyondAtc.start()
    await opened()
    const done = finished(replay)
    replay.sim.start()
    await done

    expect(beyondAtc.getState().infoBoxesAt).toBe(Date.parse(CAPTURED_AT) + 2500)
    beyondAtc.stop()
  })

  it('drops lines that arrive while the service is not connected, as a real server would', async () => {
    const replay = replayCapture(
      capture([{ type: 'beyondatc', tOffsetMs: 1500, direction: 'in', text: STAR_BOXES }])
    )
    const done = finished(replay)
    replay.sim.start()
    await done

    expect(replay.beyondAtc.dropped).toEqual([STAR_BOXES])
  })

  it('refuses a clock for a capture without a valid capturedAt', () => {
    const bad = capture([])
    expect(() =>
      replayCapture(
        { ...bad, header: { ...bad.header, capturedAt: 'unknown' } },
        { setClock: () => undefined }
      )
    ).toThrow(/no valid capturedAt/)
  })
})

describe('ReplaySocketLink', () => {
  it('reconnects: a new socket after a close receives the following lines', async () => {
    const link = new ReplaySocketLink()
    const beyondAtc = new BeyondAtcService('replay', 0, link.socketCtor)
    beyondAtc.start()
    await opened()
    beyondAtc.reconfigure('replay-again')
    await opened()

    link.deliver(STAR_BOXES)
    expect(beyondAtc.getState().infoBoxes).toHaveLength(2)
    beyondAtc.stop()
  })
})
