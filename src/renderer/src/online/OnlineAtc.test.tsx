import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { NetworkControllers } from '@shared/ipc'
import { LiveClientContext, type LiveClient } from '../live/LiveClient'
import { OnlineAtcButton, OnlineAtcSection } from './OnlineAtc'

const HEATHROW: NetworkControllers = {
  network: 'vatsim',
  airports: [
    {
      icao: 'EGLL',
      stations: [
        { callsign: 'EGLL_GND', frequency: '121.700', position: 'gnd' },
        { callsign: 'EGLL_TWR', frequency: '118.700', position: 'twr' }
      ],
      atis: [
        { callsign: 'EGLL_D_ATIS', code: 'C', frequency: '121.850' },
        { callsign: 'EGLL_ATIS2', code: null, frequency: '128.075' }
      ]
    },
    { icao: 'LFPG', stations: [], atis: [] }
  ]
}

/** Renders `ui` against a live client holding `initial`, and returns a way to push the topic's next value. */
function renderWith(
  initial: NetworkControllers | undefined,
  ui: React.JSX.Element
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
  render(<LiveClientContext.Provider value={client}>{ui}</LiveClientContext.Provider>)
  return (value) => push(value)
}

/** Renders the PC's button against `initial`, presses it, and returns the pop-up. */
async function openPopup(initial: NetworkControllers): Promise<HTMLElement> {
  renderWith(initial, <OnlineAtcButton />)
  await userEvent.click(await screen.findByRole('button', { name: /ATC/ }))
  return screen.getByRole('dialog')
}

describe('OnlineAtcButton', () => {
  it('names the network and how many controllers are online at the flight’s airports, and opens them in a pop-up', async () => {
    renderWith(HEATHROW, <OnlineAtcButton />)
    // Two controllers at EGLL, none at LFPG; the ATIS stations are not controllers.
    await userEvent.click(await screen.findByRole('button', { name: 'VATSIM ATC (2)…' }))
    const popup = screen.getByRole('dialog')
    expect(within(popup).getByText('Online ATC at your airports (VATSIM)')).toBeInTheDocument()
    const heathrow = within(popup).getByRole('region', { name: 'EGLL' })
    expect(within(heathrow).getByText('GND')).toBeInTheDocument()
    expect(within(heathrow).getByText('EGLL_GND')).toBeInTheDocument()
    expect(within(heathrow).getByText('121.700')).toBeInTheDocument()
    expect(within(heathrow).getByText('118.700')).toBeInTheDocument()
  })

  it('lists each ATIS station’s frequency among the controllers, with its letter, and none of the ATIS text', async () => {
    const heathrow = within(await openPopup(HEATHROW)).getByRole('region', { name: 'EGLL' })
    const row = within(heathrow).getByText('EGLL_D_ATIS').closest('li')!
    expect(within(row).getByText('ATIS')).toBeInTheDocument()
    expect(within(row).getByText('121.850')).toBeInTheDocument()
    expect(within(row).getByText('C')).toBeInTheDocument()
    expect(within(heathrow).getByText('128.075')).toBeInTheDocument()
    // The text and the runway suggestion are in the weather panel now.
    expect(within(heathrow).queryByText(/Runway in use/)).not.toBeInTheDocument()
  })

  it('says when nobody is online at an airport, and that enroute controllers are not listed', async () => {
    const popup = await openPopup(HEATHROW)
    expect(
      within(within(popup).getByRole('region', { name: 'LFPG' })).getByText('No controllers online')
    ).toBeInTheDocument()
    expect(within(popup).getByText('Enroute controllers are not listed.')).toBeInTheDocument()
  })

  it('scrolls inside the pop-up, so a busy event’s three airports never run off the screen', async () => {
    const popup = await openPopup(HEATHROW)
    expect(within(popup).getByRole('region', { name: 'EGLL' }).closest('.overflow-y-auto')).toHaveClass(
      'max-h-[70vh]'
    )
  })

  it('names IVAO for IVAO', async () => {
    renderWith({ ...HEATHROW, network: 'ivao' }, <OnlineAtcButton />)
    expect(await screen.findByRole('button', { name: 'IVAO ATC (2)…' })).toBeInTheDocument()
  })

  it('is not there with no network chosen or no flight’s airports, says (0) when nobody is online, and follows the topic', async () => {
    const push = renderWith({ network: null, airports: [] }, <OnlineAtcButton />)
    expect(screen.queryByRole('button', { name: /ATC/ })).not.toBeInTheDocument()
    act(() => push({ network: 'vatsim', airports: [] }))
    expect(screen.queryByRole('button', { name: /ATC/ })).not.toBeInTheDocument()
    act(() => push({ network: 'vatsim', airports: [{ icao: 'EGLL', stations: [], atis: [] }] }))
    expect(screen.getByRole('button', { name: 'VATSIM ATC (0)…' })).toBeInTheDocument()
    act(() => push(HEATHROW))
    expect(screen.getByRole('button', { name: 'VATSIM ATC (2)…' })).toBeInTheDocument()
    act(() => push({ network: null, airports: [] }))
    expect(screen.queryByRole('button', { name: /ATC/ })).not.toBeInTheDocument()
  })
})

describe('OnlineAtcSection', () => {
  it('draws as a folded section on the phone, with the same content inside', async () => {
    renderWith(HEATHROW, <OnlineAtcSection />)
    const summary = await screen.findByText('Online ATC at your airports (VATSIM)')
    const details = summary.closest('details')
    expect(details).not.toBeNull()
    expect(details).not.toHaveAttribute('open')
    expect(within(details!).getByText('EGLL_TWR')).toBeInTheDocument()
    expect(within(details!).getByText('121.850')).toBeInTheDocument()
  })

  it('is not there with no network chosen', () => {
    renderWith({ network: null, airports: [] }, <OnlineAtcSection />)
    expect(screen.queryByText(/Online ATC/)).not.toBeInTheDocument()
  })
})
