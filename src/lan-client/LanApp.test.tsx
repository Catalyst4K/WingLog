import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FlightMapProps } from '@/FlightMap'
import { LanApp } from './LanApp'
import { LanConnection, type LinkSocket, type TokenStore } from './lan-connection'

// The map itself needs WebGL (jsdom has none) and is covered by FlightMap.test.tsx and the second-screen acceptance test; here it only
// records what the page hands it.
const mapProps = vi.hoisted(() => ({ current: null as FlightMapProps | null }))
vi.mock('@/FlightMap', () => ({
  FlightMap: (props: FlightMapProps) => {
    mapProps.current = props
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
    const runway = within(within(dialog).getByText('Departure runway').closest('div')!).getByRole('combobox')
    await userEvent.click(runway)
    await userEvent.click(await screen.findByRole('option', { name: '02C' }))
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
    const runway = within(within(dialog).getByText('Departure runway').closest('div')!).getByRole('combobox')
    await userEvent.click(runway)
    await userEvent.click(await screen.findByRole('option', { name: '02L' }))
    expect(runway).toHaveTextContent('02L')
  })
})

describe('LanApp', () => {
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

  it('warns when the link to the PC drops, and carries on from the last picture', () => {
    const { link, sockets } = setup('tok')
    render(<LanApp link={link} />)
    act(() => {
      sockets[0].onopen?.()
      sockets[0].say({ t: 'snapshot', topics: {}, flight: null })
    })
    act(() => sockets[0].onclose?.())
    expect(screen.getByText("Can't reach the PC. Trying again…")).toBeInTheDocument()
    expect(screen.queryByText('No flight is being tracked on the PC yet.')).not.toBeInTheDocument()
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
