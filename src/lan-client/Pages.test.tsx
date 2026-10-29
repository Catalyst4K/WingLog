import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EMPTY_BEYONDATC_STATE } from '@shared/beyondatc-state'
import { LanApp } from './LanApp'
import { LanConnection, type LinkSocket, type TokenStore } from './lan-connection'
import { LiveClientContext } from '@/live/LiveClient'
import { lanLiveClient } from './lan-live-client'

// The map needs WebGL (jsdom has none): FlightMap.test.tsx and the acceptance test cover it.
vi.mock('@/FlightMap', () => ({ FlightMap: () => <div data-testid="map" /> }))

class FakeSocket implements LinkSocket {
  readyState = 1
  sent: Record<string, unknown>[] = []
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

// A trimmed SimBrief OFP with the field names of a real one (as simbrief-client.test.ts), not real flight data.
const OFP = JSON.stringify({
  fetch: { status: 'Success' },
  params: { request_id: '12345', units: 'kgs' },
  origin: { icao_code: 'EGLL' },
  destination: { icao_code: 'VHHH' },
  alternate: { icao_code: 'VMMC' },
  general: {
    icao_airline: 'BAW',
    flight_number: '31',
    route: 'BPK7F BPK DCT',
    initial_altitude: '33000',
    costindex: '85'
  },
  aircraft: { icaocode: 'A35K', reg: 'G-XWBS', internal_id: 'A35K', is_custom: '0' },
  weights: { pax_count: '328', cargo: '8200', est_zfw: '189112', est_tow: '273642', est_ldw: '198861' },
  fuel: { plan_ramp: '85029' },
  times: { sched_out: '1787860800', sched_in: '1787898900' },
  navlog: {
    fix: [
      { ident: 'BPK', altitude_feet: '4000', distance: '5', pos_lat: '51.7', pos_long: '0.1' },
      { ident: 'VHHH', altitude_feet: '0', distance: '20', pos_lat: '22.3', pos_long: '113.9' }
    ]
  }
})

const FLIGHT = {
  flight: {
    flightId: 7,
    depIcao: 'EGLL',
    arrIcao: 'VHHH',
    flightNumber: 'BAW31',
    schedInUtc: null,
    registration: 'G-XWBS',
    icaoType: 'A35K',
    ofpJson: OFP,
    selection: {
      departureRunway: null,
      sidIdent: null,
      sidTransition: null,
      starIdent: null,
      starTransition: null,
      approachIdent: null,
      approachTransition: null,
      arrivalIcao: null
    }
  },
  trackPoints: []
}

/** Opens the page, signed in, and answers the PC lookups the way the PC would. */
function open(options: { flight?: unknown; gsx?: boolean; atc?: boolean; weightUnit?: string } = {}) {
  let stored: string | null = 'tok'
  const store: TokenStore = { get: () => stored, set: (t) => (stored = t), clear: () => (stored = null) }
  const sockets: FakeSocket[] = []
  const link = new LanConnection(
    'ws://pc/live',
    store,
    () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    'iPad'
  )
  link.start()
  render(
    <LiveClientContext.Provider value={lanLiveClient(link)}>
      <LanApp link={link} />
    </LiveClientContext.Provider>
  )
  const socket = sockets[0]
  act(() => {
    socket.onopen?.()
    socket.say({ t: 'snapshot', topics: {}, flight: options.flight === undefined ? FLIGHT : options.flight })
  })
  /** Answers the lookup the page just asked, in the order it asked them. */
  const answers: Record<string, unknown> = {
    'settings.display': {
      weightUnit: options.weightUnit ?? 'kg',
      altitudeUnit: 'ft',
      windSpeedUnit: 'kt',
      mapLanguage: 'en'
    },
    'settings.gsxRemote': { enabled: options.gsx ?? false, host: '', port: 1 },
    'settings.beyondAtc': { enabled: options.atc ?? false, host: '' }
  }
  act(() => {
    for (const message of socket.sent) {
      if (message.t === 'query' && typeof message.name === 'string' && message.name in answers) {
        socket.say({ t: 'result', id: message.id, data: answers[message.name] })
      }
    }
  })
  return { socket }
}

/** A window.winglog that answers what the shared panels read from it. */
function stubWinglog(overrides: Record<string, unknown> = {}): void {
  window.winglog = {
    weatherGetMetars: vi.fn().mockResolvedValue([]),
    onlineAtisGet: vi.fn().mockResolvedValue({ network: null, airports: [] }),
    settingsGetGsxRemote: vi.fn().mockResolvedValue({ enabled: true, host: '', port: 1 }),
    settingsGetBeyondAtc: vi.fn().mockResolvedValue({ enabled: true, host: '' }),
    navdataGetStands: vi.fn().mockResolvedValue([]),
    appLogRendererError: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as typeof window.winglog
}

describe('the pages bar', () => {
  it('offers Track and Dispatch, and ground services and BeyondATC only when the PC has them on', async () => {
    stubWinglog()
    open()
    const bar = screen.getByRole('navigation')
    expect(bar).toHaveTextContent('Track')
    expect(bar).toHaveTextContent('Dispatch')
    expect(bar).not.toHaveTextContent('Weather')
    expect(bar).not.toHaveTextContent('Ground services')
    expect(bar).not.toHaveTextContent('BeyondATC')
    open({ gsx: true, atc: true })
    await waitFor(() => expect(screen.getAllByRole('navigation').at(-1)).toHaveTextContent('Ground services'))
    expect(screen.getAllByRole('navigation').at(-1)).toHaveTextContent('BeyondATC')
  })

  it('starts on Track, marks the page that is open, and keeps the map mounted while another page is shown', async () => {
    stubWinglog()
    open()
    expect(screen.getByRole('button', { name: 'Track' })).toHaveAttribute('aria-current', 'page')
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    expect(screen.getByRole('button', { name: 'Dispatch' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Track' })).not.toHaveAttribute('aria-current')
    expect(screen.getByTestId('map')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Track' }))
    expect(screen.getByRole('button', { name: 'Track' })).toHaveAttribute('aria-current', 'page')
  })

  it('has touch-sized buttons', () => {
    stubWinglog()
    open()
    for (const button of screen.getByRole('navigation').querySelectorAll('button')) {
      expect(button.className).toContain('min-h-14')
    }
  })
})

describe('the Track page while the pilot is online', () => {
  it("shows the online badge in the flight banner, no BeyondATC note, and warns while BeyondATC's auto-tune is on", async () => {
    stubWinglog()
    const { socket } = open()
    act(() => {
      socket.say({
        t: 'topic',
        name: 'onlineStatus',
        payload: {
          network: 'vatsim',
          state: 'online',
          callsign: 'TSTPIL1',
          filedPlan: null,
          hidesBeyondAtc: true
        }
      })
      socket.say({ t: 'topic', name: 'beyondAtcStatus', payload: { state: 'connected', lastError: null } })
      socket.say({
        t: 'topic',
        name: 'beyondAtcState',
        payload: { ...EMPTY_BEYONDATC_STATE, autoTune: true }
      })
    })
    expect(await screen.findByText('VATSIM · TSTPIL1')).toHaveAttribute(
      'title',
      'Online on VATSIM as TSTPIL1.'
    )
    expect(screen.queryByText(/BeyondATC is hidden/)).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent("BeyondATC's auto-tune is on")
  })
})

describe('the Dispatch page', () => {
  it("shows the flight plan's figures as the Dispatch screen does, in the PC's units", async () => {
    stubWinglog()
    open({ weightUnit: 'lb' })
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    expect(await screen.findByText(/BAW31: EGLL → VHHH \(altn VMMC\)/)).toBeInTheDocument()
    expect(screen.getByText('A35K G-XWBS')).toBeInTheDocument()
    // 189,112 kg ZFW in pounds, once the PC has said its unit is lb.
    await waitFor(() =>
      expect(screen.getByText(/416,9\d\d lb \/ 603,\d{3} lb \/ 438,\d{3} lb/)).toBeInTheDocument()
    )
    expect(screen.getByText('328 / 8,200 kg'.replace('8,200 kg', '18,078 lb'))).toBeInTheDocument()
  })

  it('says there is no plan when the PC has none, or its OFP cannot be read', async () => {
    stubWinglog()
    open({ flight: null })
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    expect(screen.getByText(/No flight plan on the PC yet/)).toBeInTheDocument()
  })

  it('says there is no plan for a flight whose OFP is damaged', async () => {
    stubWinglog()
    open({ flight: { ...FLIGHT, flight: { ...FLIGHT.flight, ofpJson: '{not json' } } })
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    expect(screen.getByText(/No flight plan on the PC yet/)).toBeInTheDocument()
  })
})

describe('the weather on the Dispatch page', () => {
  it('comes before the flight plan', async () => {
    stubWinglog()
    open()
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    const weather = await screen.findByRole('tab', { name: 'Dep' })
    const plan = await screen.findByText(/BAW31: EGLL → VHHH/)
    expect(weather.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("asks the PC for the flight's airports and shows the weather panel under the plan", async () => {
    stubWinglog()
    open()
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    expect(await screen.findByRole('tab', { name: 'Dep' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Weather' })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(window.winglog.weatherGetMetars).toHaveBeenCalledWith(['EGLL', 'VHHH', 'VMMC'])
    )
  })
})

describe('the weather panel on the Dispatch page', () => {
  it('shows the live ATIS under the METAR, asked for with the flight’s airports and the tab each is for', async () => {
    stubWinglog({
      onlineAtisGet: vi.fn().mockResolvedValue({
        network: 'vatsim',
        airports: [
          {
            icao: 'EGLL',
            slot: 'departure',
            state: 'shown',
            atis: [
              {
                callsign: 'EGLL_D_ATIS',
                code: 'L',
                kind: 'departure',
                lines: ['DEPARTURE INFORMATION LIMA'],
                runway: '27R'
              }
            ]
          }
        ]
      })
    })
    open()
    await userEvent.click(screen.getByRole('button', { name: 'Dispatch' }))
    expect(await screen.findByText('VATSIM departure ATIS L · runway 27R')).toBeInTheDocument()
    await waitFor(() =>
      expect(window.winglog.onlineAtisGet).toHaveBeenCalledWith([
        { icao: 'EGLL', slot: 'departure' },
        { icao: 'VHHH', slot: 'destination' },
        { icao: 'VMMC', slot: 'alternate' }
      ])
    )
  })
})

describe('the ground services and BeyondATC pages', () => {
  it('show the same panels as the app, once the PC has them on', async () => {
    stubWinglog()
    open({ gsx: true, atc: true })
    await userEvent.click(await screen.findByRole('button', { name: 'Ground services' }))
    expect(await screen.findByRole('heading', { name: 'Ground services' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'BeyondATC' }))
    expect(await screen.findByRole('heading', { name: 'BeyondATC' })).toBeInTheDocument()

    // Grows with its content rather than being the scroller's height, so a tall transcript keeps the page's bottom padding above the bar.
    expect(screen.getByTestId('beyondatc-page')).toHaveClass('min-h-full')
    expect(screen.getByTestId('beyondatc-page')).not.toHaveClass('h-full')
  })

  it('send an action to the PC the way the app does', async () => {
    stubWinglog()
    const { socket } = open({ gsx: true, atc: true })
    act(() => {
      socket.say({ t: 'topic', name: 'beyondAtcStatus', payload: { state: 'connected', lastError: null } })
      socket.say({
        t: 'topic',
        name: 'beyondAtcState',
        payload: { ...EMPTY_BEYONDATC_STATE, actions: ['Request Taxi'] }
      })
    })
    await userEvent.click(await screen.findByRole('button', { name: 'BeyondATC' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Request Taxi' }))
    expect(socket.sent.at(-1)).toEqual({ t: 'cmd', name: 'atc.setAction', args: ['Request Taxi'] })
  })
})
