import { act, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NetworkControllers } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from '../live/LiveClient'
import { OnlineAtcCard } from './OnlineAtcCard'

const HEATHROW: NetworkControllers = {
  network: 'vatsim',
  airports: [
    {
      icao: 'EGLL',
      stations: [
        { callsign: 'EGLL_GND', frequency: '121.700', position: 'gnd', name: 'Test Controller' },
        { callsign: 'EGLL_TWR', frequency: '118.700', position: 'twr', name: null }
      ],
      atis: [
        {
          callsign: 'EGLL_ATIS',
          code: 'C',
          lines: ['WIND CALM', '<img src=x onerror=alert(1)>'],
          runway: '27L'
        },
        { callsign: 'EGLL_ATIS2', code: null, lines: ['RWY 09 AND 27'], runway: null }
      ]
    },
    { icao: 'LFPG', stations: [], atis: [] }
  ]
}

function renderCard(
  initial: NetworkControllers | undefined,
  compact = false
): (value: NetworkControllers) => void {
  let push: (value: NetworkControllers) => void = () => undefined
  const client = {
    get: () => Promise.resolve(initial),
    subscribe: (_topic: string, listener: (value: NetworkControllers) => void) => {
      push = listener
      return () => undefined
    },
    command: vi.fn()
  } as unknown as LiveClient
  render(
    <LiveClientContext.Provider value={client}>
      <OnlineAtcCard compact={compact} />
    </LiveClientContext.Provider>
  )
  return (value) => push(value)
}

describe('OnlineAtcCard', () => {
  it('lists each airport’s controllers with position, callsign, frequency and name', async () => {
    renderCard(HEATHROW)
    const heathrow = await screen.findByRole('region', { name: 'EGLL' })
    expect(within(heathrow).getByText('GND')).toBeInTheDocument()
    expect(within(heathrow).getByText('EGLL_GND')).toBeInTheDocument()
    expect(within(heathrow).getByText('121.700')).toBeInTheDocument()
    expect(within(heathrow).getByText('Test Controller')).toBeInTheDocument()
    expect(within(heathrow).getByText('118.700')).toBeInTheDocument()
    expect(screen.getByText('Online ATC at your airports (VATSIM)')).toBeInTheDocument()
  })

  it('shows the ATIS letter and its text as text only', async () => {
    renderCard(HEATHROW)
    const heathrow = await screen.findByRole('region', { name: 'EGLL' })
    expect(within(heathrow).getByText('ATIS C · EGLL_ATIS')).toBeInTheDocument()
    expect(within(heathrow).getByText('WIND CALM')).toBeInTheDocument()
    expect(within(heathrow).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(heathrow.querySelector('img')).toBeNull()
  })

  it('suggests the runway beside the ATIS that names exactly one, and not beside one that names several', async () => {
    renderCard(HEATHROW)
    const heathrow = await screen.findByRole('region', { name: 'EGLL' })
    const suggestions = within(heathrow).getAllByText(/Runway in use \(from the ATIS\)/)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toHaveTextContent('Runway in use (from the ATIS): 27L')
  })

  it('says when nobody is online at an airport, and that enroute controllers are not listed', async () => {
    renderCard(HEATHROW)
    const paris = await screen.findByRole('region', { name: 'LFPG' })
    expect(within(paris).getByText('No controllers online')).toBeInTheDocument()
    expect(screen.getByText('Enroute controllers are not listed.')).toBeInTheDocument()
  })

  it('names IVAO for IVAO', async () => {
    renderCard({ ...HEATHROW, network: 'ivao' })
    expect(await screen.findByText('Online ATC at your airports (IVAO)')).toBeInTheDocument()
  })

  it('shows nothing with no network chosen or no airports, and appears when a flight is tracked', async () => {
    const push = renderCard({ network: null, airports: [] })
    expect(screen.queryByText(/Online ATC/)).not.toBeInTheDocument()
    act(() => push({ network: 'vatsim', airports: [] }))
    expect(screen.queryByText(/Online ATC/)).not.toBeInTheDocument()
    act(() => push(HEATHROW))
    expect(screen.getByText('Online ATC at your airports (VATSIM)')).toBeInTheDocument()
    act(() => push({ network: 'vatsim', airports: [] }))
    expect(screen.queryByText(/Online ATC/)).not.toBeInTheDocument()
  })

  it('keeps its content inside a bounded, scrolling area on the PC, so it never takes the map’s room', async () => {
    renderCard(HEATHROW)
    const heathrow = await screen.findByRole('region', { name: 'EGLL' })
    expect(heathrow.closest('.overflow-y-auto')).toHaveClass('max-h-64')
  })

  it('draws as a collapsed section on the phone, with the same content inside', async () => {
    renderCard(HEATHROW, true)
    const summary = await screen.findByText('Online ATC at your airports (VATSIM)')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute('open')
    expect(within(details!).getByText('EGLL_TWR')).toBeInTheDocument()
  })
})
