import i18n from 'i18next'
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FlightMapProps } from '@/FlightMap'
import { LanApp } from './LanApp'
import { LanConnection, type LinkSocket, type TokenStore } from './lan-connection'

// The choice is sent again after CONFIRM_MS and the notice goes after NOTICE_MS: shortened so the tests need not wait.
vi.mock('./selection-sync', async (original) => ({
  ...(await original<typeof import('./selection-sync')>()),
  CONFIRM_MS: 400,
  NOTICE_MS: 500
}))

// The map itself needs WebGL (jsdom has none) and is covered by FlightMap.test.tsx and the second-screen acceptance test; here it only
// records what the page hands it.
const mapProps = vi.hoisted(() => ({ current: null as FlightMapProps | null, explode: false }))
vi.mock('@/FlightMap', () => ({
  FlightMap: (props: FlightMapProps) => {
    mapProps.current = props
    if (mapProps.explode) throw new Error('the map failed to draw')
    return <div data-testid="map" />
  }
}))

class FakeSocket implements LinkSocket {
  readyState = 1
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send(text: string): void {
    this.sent.push(JSON.parse(text))
  }
  close(): void {
    this.onclose?.()
  }
  say(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const OFP = JSON.stringify({
  navlog: {
    fix: [
      { ident: 'WSSS', pos_lat: '1.3644', pos_long: '103.9915', stage: 'CLB' },
      { ident: 'EGLL', pos_lat: '51.4775', pos_long: '-0.4614', stage: 'CRZ' }
    ]
  }
})

function setup(token: string | null = null) {
  let stored = token
  const store: TokenStore = { get: () => stored, set: (t) => (stored = t), clear: () => (stored = null) }
  const sockets: FakeSocket[] = []
  const link = new LanConnection(
    'ws://192.168.1.136:8765/live',
    store,
    () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    'iPad (Safari)'
  )
  link.start()
  return { link, sockets }
}

/** Stands in for the PC's navdata, the one thing the Procedures dialog reads through window.winglog. */
function stubNavdata(overrides: Record<string, unknown> = {}): void {
  window.winglog = {
    navdataRefreshAirport: vi.fn().mockResolvedValue(undefined),
    navdataListRunways: vi.fn().mockResolvedValue([{ ident: '02L' }, { ident: '02C' }]),
    navdataListSids: vi.fn().mockResolvedValue([]),
    navdataListStars: vi.fn().mockResolvedValue([]),
    navdataListApproaches: vi.fn().mockResolvedValue([]),
    navdataGetProcedureWaypoints: vi.fn().mockResolvedValue([]),
    appLogRendererError: vi.fn().mockResolvedValue(undefined),
    getStorageStatus: vi.fn().mockResolvedValue({ freeBytes: null, level: 'ok', saveFailing: false }),
    onStorageStatus: vi.fn().mockReturnValue(() => {}),
    ...overrides
  } as unknown as typeof window.winglog
}

const FLIGHT_WITH_SELECTION = {
  flight: {
    flightId: 7,
    depIcao: 'WSSS',
    arrIcao: 'EGLL',
    flightNumber: null,
    schedInUtc: null,
    registration: null,
    icaoType: null,
    ofpJson: null,
    selection: {
      departureRunway: null,
      sidIdent: 'KAMI2A',
      sidTransition: null,
      starIdent: 'SIER7B',
      starTransition: null,
      approachIdent: 'ILS 27L',
      approachTransition: null,
      arrivalIcao: null
    }
  },
  trackPoints: []
}

/** A route the PC pushes for flight 7, built from a choice. */
function pcRoute(revision: number, selection: unknown) {
  return { t: 'topic', name: 'plannedRoute', payload: { flightId: 7, revision, selection, waypoints: [] } }
}

describe('the Procedures button', () => {
  it('shows what is chosen, and nothing-selected-yet when nothing is', () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: FLIGHT_WITH_SELECTION })
    })
    expect(screen.getByRole('button', { name: 'Procedures…' })).toBeInTheDocument()
    expect(screen.getByText('KAMI2A · SIER7B · ILS 27L')).toBeInTheDocument()
  })

  it("follows a change made on the PC's own window, and ignores an announcement of nothing", () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: FLIGHT_WITH_SELECTION })
    })
    expect(screen.getByText('KAMI2A · SIER7B · ILS 27L')).toBeInTheDocument()
    act(() =>
      sockets[0].say(
        pcRoute(2, { ...FLIGHT_WITH_SELECTION.flight.selection, sidIdent: 'DET2G', approachIdent: 'ILS 27R' })
      )
    )
    expect(screen.getByText('DET2G · SIER7B · ILS 27R')).toBeInTheDocument()
    act(() => sockets[0].say({ t: 'topic', name: 'plannedRoute', payload: null }))
    expect(screen.getByText('DET2G · SIER7B · ILS 27R')).toBeInTheDocument()
  })

  it('is not shown before a flight is being tracked', () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
    })
    expect(screen.queryByRole('button', { name: 'Procedures…' })).not.toBeInTheDocument()
  })

  it('opens the same dialog as the Track screen, and sends a choice to the PC', async () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({
        t: 'snapshot',
        topics: {},
        flight: {
          ...FLIGHT_WITH_SELECTION,
          flight: {
            ...FLIGHT_WITH_SELECTION.flight,
            selection: {
              ...FLIGHT_WITH_SELECTION.flight.selection,
              sidIdent: null,
              starIdent: null,
              approachIdent: null
            }
          }
        }
      })
    })
    expect(screen.getByText('Nothing selected yet')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Procedures…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('tab', { name: 'Departure' })).toBeInTheDocument()
    expect(within(dialog).getByRole('tab', { name: 'Arrival' })).toBeInTheDocument()
    const runway = await within(dialog).findByLabelText('Departure runway')
    await userEvent.selectOptions(runway, '02C')
    expect(sockets[0].sent.at(-1)).toEqual({
      t: 'cmd',
      name: 'track.setProcedureSelection',
      args: [expect.objectContaining({ departureRunway: '02C' })]
    })
  })

  it('still shows the choice when the link is down, without throwing', async () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: FLIGHT_WITH_SELECTION })
    })
    act(() => sockets[0].onclose?.())
    await userEvent.click(screen.getByRole('button', { name: 'Procedures…' }))
    const dialog = await screen.findByRole('dialog')
    const runway = await within(dialog).findByLabelText('Departure runway')
    await userEvent.selectOptions(runway, '02L')
    expect(runway).toHaveValue('02L')
  })
})

describe('keeping the choice in step with the PC (docs/plans/lan-sync.md)', () => {
  const CHOICE = { ...FLIGHT_WITH_SELECTION.flight.selection, sidIdent: 'DET2G' }

  /** The page open on flight 7 with the PC's route at revision 1, and a choice made through the Procedures dialog. */
  async function openAndChoose() {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: FLIGHT_WITH_SELECTION })
      sockets[0].say(pcRoute(1, FLIGHT_WITH_SELECTION.flight.selection))
    })
    await userEvent.click(screen.getByRole('button', { name: 'Procedures…' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.selectOptions(await within(dialog).findByLabelText('Departure runway'), '02C')
    await userEvent.keyboard('{Escape}')
    const sentChoices = (): unknown[] =>
      sockets[0].sent.filter((m) => (m as { name?: string }).name === 'track.setProcedureSelection')
    return { sockets, sentChoices }
  }

  it('sends the choice again when the PC does not confirm it, and says so after the last try, back on what the PC has', async () => {
    const { sentChoices } = await openAndChoose()
    await waitFor(() => expect(sentChoices()).toHaveLength(3), { timeout: 4000 })
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      "Couldn't reach WingLog on the PC"
    )
    expect(sentChoices()).toHaveLength(3)
    // The PC never heard it, so the page shows what the PC has.
    expect(screen.getByText('KAMI2A · SIER7B · ILS 27L')).toBeInTheDocument()
    // The notice goes by itself.
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument(), { timeout: 4000 })
  })

  it('stops sending once the PC confirms with the route built from the choice, and says nothing', async () => {
    const { sockets, sentChoices } = await openAndChoose()
    const sent = (sentChoices()[0] as { args: unknown[] }).args[0]
    act(() => sockets[0].say(pcRoute(2, sent)))
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(sentChoices()).toHaveLength(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('is not undone by a route for an earlier choice arriving while it waits', async () => {
    const { sockets, sentChoices } = await openAndChoose()
    act(() => sockets[0].say(pcRoute(2, { ...CHOICE, sidIdent: 'EARLIER1A' })))
    expect(screen.queryByText(/EARLIER1A/)).not.toBeInTheDocument()
    const sent = (sentChoices()[0] as { args: unknown[] }).args[0]
    act(() => sockets[0].say(pcRoute(3, sent)))
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('pop-ups from the other apps (docs/plans/lan-popups.md)', () => {
  const PUSHBACK = {
    menuShown: true,
    searchActive: false,
    searchSession: 0,
    title: 'Select pushback direction',
    header: '',
    subtitle: '',
    entries: ['Left', 'Right'],
    icons: [],
    disabled: [],
    layout: 'list'
  }
  const STAR_CLEARANCE = { infoBoxes: [{ title: 'STAR', info: 'LOGA2H' }], infoBoxesAt: 1_000 }

  it('shows GSX’s important menu over any page, and sends the answer to the PC', async () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: { gsxRemoteMenu: PUSHBACK }, flight: null })
    })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('GSX needs your input')).toBeInTheDocument()
    expect(within(dialog).getByText('Select pushback direction')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Right' }))
    expect(sockets[0].sent.at(-1)).toEqual({ t: 'cmd', name: 'gsx.pickMenu', args: [1] })
    // GSX clears the menu once it has the answer: the prompt goes with it.
    act(() =>
      sockets[0].say({
        t: 'topic',
        name: 'gsxRemoteMenu',
        payload: { ...PUSHBACK, menuShown: false, entries: [] }
      })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers a BeyondATC clearance on the phone, and Update sends the new choice to the PC', async () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: FLIGHT_WITH_SELECTION })
    })
    act(() => sockets[0].say({ t: 'topic', name: 'beyondAtcState', payload: STAR_CLEARANCE }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Update procedure from ATC clearance?')).toBeInTheDocument()
    expect(within(dialog).getByText(/SIER7B/)).toBeInTheDocument()
    expect(within(dialog).getByText(/LOGA2H/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(sockets[0].sent.at(-1)).toEqual({
      t: 'cmd',
      name: 'track.setProcedureSelection',
      args: [expect.objectContaining({ starIdent: 'LOGA2H', approachIdent: 'ILS 27L' })]
    })
    expect(screen.getByText('KAMI2A · LOGA2H · ILS 27L')).toBeInTheDocument()
  })

  it('closes the phone’s prompt when the PC answers it first', async () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: FLIGHT_WITH_SELECTION })
    })
    act(() => sockets[0].say({ t: 'topic', name: 'beyondAtcState', payload: STAR_CLEARANCE }))
    await screen.findByRole('dialog')
    act(() => sockets[0].say(pcRoute(2, { ...FLIGHT_WITH_SELECTION.flight.selection, starIdent: 'LOGA2H' })))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('LanApp', () => {
  it("looks the way the PC's settings say: its map language on the map, its language and theme on the page", async () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: FLIGHT_WITH_SELECTION })
    })
    // The page asks the PC for its display settings and the add-on switches; the PC answers.
    const queries = (sockets[0].sent as { t: string; id: number; name: string }[]).filter(
      (m) => m.t === 'query'
    )
    const answer = (name: string, data: unknown): void => {
      const asked = queries.find((m) => m.name === name)
      expect(asked).toBeDefined()
      sockets[0].say({ t: 'result', id: asked!.id, data })
    }
    await act(async () => {
      answer('settings.display', {
        weightUnit: 'kg',
        altitudeUnit: 'ft',
        windSpeedUnit: 'kt',
        appLanguage: 'de',
        systemLocale: 'en-US',
        theme: 'dark',
        mapLanguage: 'fr'
      })
      answer('settings.gsxRemote', { enabled: false })
      answer('settings.beyondAtc', { enabled: false })
      await Promise.resolve()
    })
    expect(mapProps.current?.mapLanguage).toBe('fr')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verfahren…' })).toBeInTheDocument())
    // The page is global state: leave it as the other tests expect it.
    await i18n.changeLanguage('en')
    document.documentElement.classList.remove('dark')
  })

  it('asks for the pairing code first, and sends it to the PC', async () => {
    const { link, sockets } = setup()
    render(<LanApp link={link} />)
    expect(screen.getByRole('heading', { name: 'Pair with WingLog' })).toBeInTheDocument()
    const pair = screen.getByRole('button', { name: 'Pair' })
    expect(pair).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Pairing code'), '48a291 3')
    expect(screen.getByLabelText('Pairing code')).toHaveValue('482913')
    await userEvent.click(pair)
    act(() => sockets[0].onopen?.())
    expect(sockets[0].sent).toEqual([{ t: 'pair', code: '482913', name: 'iPad (Safari)' }])
  })

  it('says so when the code was wrong', async () => {
    const { link, sockets } = setup()
    render(<LanApp link={link} />)
    await userEvent.type(screen.getByLabelText('Pairing code'), '000000')
    await userEvent.click(screen.getByRole('button', { name: 'Pair' }))
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'denied' })
    })
    expect(await screen.findByRole('alert')).toHaveTextContent("That code didn't work")
  })

  it('shows a connecting message while it says hello with the stored token', () => {
    const { link } = setup('tok')
    render(<LanApp link={link} />)
    expect(screen.getByText('Connecting to WingLog…')).toBeInTheDocument()
  })

  it('keeps the page bar, and the other pages, when the Track page fails to draw, and tells the PC', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mapProps.explode = true
    try {
      const { link, sockets } = setup('tok')
      render(<LanApp link={link} />)
      act(() => {
        sockets[0].onopen?.()
        sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
      })
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong showing this.')
      expect(screen.getByRole('navigation')).toBeInTheDocument()
      // Another page still opens.
      await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
      expect(
        screen.getByText('No flight plan on the PC yet. Plan a flight in Dispatch on the PC.')
      ).toBeInTheDocument()
    } finally {
      mapProps.explode = false
    }
  })

  it('says no flight is tracked when the PC has none, with the map behind it', () => {
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
    })
    expect(screen.getByText('No flight is being tracked on the PC yet.')).toBeInTheDocument()
    expect(screen.getByTestId('map')).toBeInTheDocument()
    expect(mapProps.current).toMatchObject({ live: true, route: [], trackPoints: [], telemetry: null })
  })

  it('gives the map the flight’s route, its recorded track and each new point, and the live telemetry', () => {
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    const point = (id: number, phase = 'cruise') => ({
      id,
      flightId: 7,
      latitude: 10 + id,
      longitude: 20,
      phase
    })
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({
        t: 'snapshot',
        topics: { simTelemetry: { latitude: 11, longitude: 20 } },
        flight: {
          flight: {
            flightId: 7,
            depIcao: 'WSSS',
            arrIcao: 'EGLL',
            flightNumber: 'SIA321',
            schedInUtc: null,
            registration: '9V-SKA',
            icaoType: 'A388',
            ofpJson: OFP
          },
          trackPoints: [point(1), point(2)]
        }
      })
    })
    expect(screen.queryByText('No flight is being tracked on the PC yet.')).not.toBeInTheDocument()
    expect(screen.getByText('SIA321 · WSSS → EGLL')).toBeInTheDocument()
    expect(screen.getByText('9V-SKA · A388')).toBeInTheDocument()
    expect(mapProps.current?.route).toEqual([
      [103.9915, 1.3644],
      [-0.4614, 51.4775]
    ])
    expect(mapProps.current?.trackPoints.map((p) => p.id)).toEqual([1, 2])
    expect(mapProps.current?.telemetry).toMatchObject({ latitude: 11 })
    expect(mapProps.current?.telemetryPhase).toBe('cruise')

    act(() => sockets[0].say({ t: 'topic', name: 'trackingPoint', payload: point(3, 'descent') }))
    expect(mapProps.current?.trackPoints.map((p) => p.id)).toEqual([1, 2, 3])
    expect(mapProps.current?.telemetryPhase).toBe('descent')
    act(() => sockets[0].say({ t: 'topic', name: 'trackingPoint', payload: point(3, 'descent') }))
    expect(mapProps.current?.trackPoints).toHaveLength(3)

    act(() => sockets[0].say({ t: 'topic', name: 'trackingPointsUpdated', payload: [point(2)] }))
    expect(mapProps.current?.trackPoints.map((p) => p.id)).toEqual([1, 2, 3])
  })

  it('says the sim is not connected, and gives the map no readings, while the PC has no sim: a phone that joins late is sent the last reading of one that has gone', () => {
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    const flight = {
      flight: {
        flightId: 7,
        depIcao: 'WSSS',
        arrIcao: 'EGLL',
        flightNumber: 'SIA321',
        schedInUtc: null,
        registration: '9V-SKA',
        icaoType: 'A388',
        ofpJson: OFP
      },
      trackPoints: []
    }
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({
        t: 'snapshot',
        topics: {
          simTelemetry: { latitude: 11, longitude: 20 },
          simConnectionStatus: { state: 'disconnected' }
        },
        flight
      })
    })
    expect(screen.getByText("The sim isn't connected to WingLog on the PC.")).toBeInTheDocument()
    expect(mapProps.current?.telemetry).toBeNull()

    // It comes back: the banner goes and the readings return.
    act(() =>
      sockets[0].say({
        t: 'topic',
        name: 'simConnectionStatus',
        payload: { state: 'connected', simConnectVersion: 'test' }
      })
    )
    expect(screen.queryByText("The sim isn't connected to WingLog on the PC.")).not.toBeInTheDocument()
    expect(mapProps.current?.telemetry).toMatchObject({ latitude: 11 })

    // And it goes again.
    act(() => sockets[0].say({ t: 'topic', name: 'simConnectionStatus', payload: { state: 'connecting' } }))
    expect(screen.getByText("The sim isn't connected to WingLog on the PC.")).toBeInTheDocument()
    expect(mapProps.current?.telemetry).toBeNull()
  })

  it('draws the route the PC builds and pushes, follows each new one, and ignores one for another flight', () => {
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    const waypoints = (...coords: [string, number, number][]) =>
      coords.map(([ident, lon, lat]) => ({ ident, lon, lat, altitudeFt: 0, segment: 'enroute' }))
    const route = (
      flightId: number,
      revision: number,
      sidIdent: string,
      ...coords: [string, number, number][]
    ) => ({
      t: 'topic',
      name: 'plannedRoute',
      payload: {
        flightId,
        revision,
        selection: { ...FLIGHT_WITH_SELECTION.flight.selection, sidIdent },
        waypoints: waypoints(...coords)
      }
    })
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({
        t: 'snapshot',
        topics: {},
        flight: { ...FLIGHT_WITH_SELECTION, flight: { ...FLIGHT_WITH_SELECTION.flight, ofpJson: OFP } }
      })
    })
    // Until the PC has sent a route, SimBrief's own stands in.
    expect(mapProps.current?.route).toEqual([
      [103.9915, 1.3644],
      [-0.4614, 51.4775]
    ])
    act(() => sockets[0].say(route(7, 1, 'OLD1A', ['A', 1, 2], ['B', 3, 4])))
    expect(mapProps.current?.route).toEqual([
      [1, 2],
      [3, 4]
    ])
    // The PC's next route replaces it, SID and all.
    act(() => sockets[0].say(route(7, 2, 'NEW1Z', ['C', 5, 6], ['D', 7, 8], ['E', 9, 10])))
    expect(mapProps.current?.route).toEqual([
      [5, 6],
      [7, 8],
      [9, 10]
    ])
    expect(mapProps.current?.waypoints?.map((w) => w.ident)).toEqual(['C', 'D', 'E'])
    // A route built for a different flight is never drawn on this one.
    act(() => sockets[0].say(route(8, 1, 'OTHER', ['X', 11, 12])))
    expect(mapProps.current?.route).toEqual([
      [103.9915, 1.3644],
      [-0.4614, 51.4775]
    ])
  })

  it('shows ET, time remaining and ETA once the aircraft is airborne and moving', () => {
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    const airborne = {
      id: 1,
      flightId: 7,
      latitude: 20,
      longitude: 50,
      phase: 'cruise',
      onGround: false,
      tsUtc: new Date(Date.now() - 30 * 60_000).toISOString()
    }
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({
        t: 'snapshot',
        topics: { simTelemetry: { latitude: 20, longitude: 50, groundSpeedMs: 230, onGround: false } },
        flight: {
          flight: {
            flightId: 7,
            depIcao: 'WSSS',
            arrIcao: 'EGLL',
            flightNumber: null,
            schedInUtc: null,
            registration: null,
            icaoType: null,
            ofpJson: OFP
          },
          trackPoints: [airborne]
        }
      })
    })
    expect(screen.getByText('ET')).toBeInTheDocument()
    expect(screen.getByText('Remaining')).toBeInTheDocument()
    expect(screen.getByText('ETA')).toBeInTheDocument()
    expect(screen.getByText(/^0:30:\d\d$/)).toBeInTheDocument()
  })

  it('warns when the link to the PC drops, and carries on showing the last picture', () => {
    stubNavdata()
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: FLIGHT_WITH_SELECTION })
    })
    act(() => sockets[0].onclose?.())
    expect(screen.getByText("Can't reach the PC. Trying again…")).toBeInTheDocument()
    expect(screen.getByText('KAMI2A · SIER7B · ILS 27L')).toBeInTheDocument()
  })

  it('goes back to the code screen when the PC no longer knows this device', () => {
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'denied' })
    })
    expect(screen.getByRole('heading', { name: 'Pair with WingLog' })).toBeInTheDocument()
  })
})
