import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AirportAtis, AtisSlot, WeatherAtis } from '@shared/ipc'
import i18n from '../i18n'
import { AtisLine } from './WeatherAtis'

// BeyondATC's own ATIS, as main sends it (docs/beyondatc-notes.md, 2026-10-29).
const beyondAtc: WeatherAtis = {
  callsign: 'BeyondATC',
  code: 'R',
  kind: 'single',
  lines: ['EGLL ATIS R 2338Z ARR RWY 27 RIGHT DEP RWY 27 LEFT <b>READBACK</b>'],
  runway: null,
  source: 'beyondatc',
  arrivalRunways: ['27R'],
  departureRunways: ['27L']
}
const network: WeatherAtis = {
  callsign: 'EGLL_A_ATIS',
  code: 'L',
  kind: 'arrival',
  lines: ['ARRIVAL INFORMATION LIMA'],
  runway: '27R'
}

function answer(slot: AtisSlot, atis: WeatherAtis[], extra: Partial<AirportAtis> = {}): AirportAtis {
  return { icao: 'EGLL', slot, state: atis.length > 0 ? 'shown' : 'none', atis, ...extra }
}

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe("AtisLine with BeyondATC's ATIS", () => {
  it('names the departure runway on the departure tab, with no network chosen', () => {
    render(<AtisLine answer={answer('departure', [beyondAtc])} network={null} />)
    expect(screen.getByText('BeyondATC ATIS R · departure runway 27L')).toBeInTheDocument()
  })

  it('names the arrival runway on the destination and alternate tabs', () => {
    for (const slot of ['destination', 'alternate'] as const) {
      const { unmount } = render(<AtisLine answer={answer(slot, [beyondAtc])} network={null} />)
      expect(screen.getByText('BeyondATC ATIS R · arrival runway 27R')).toBeInTheDocument()
      unmount()
    }
  })

  it('gives both runways on a custom airport, the first in the folded line and both unfolded', () => {
    render(<AtisLine answer={answer('custom', [beyondAtc])} network={null} />)
    const summary = screen.getByText('BeyondATC ATIS R · departure runway 27L')
    const details = summary.closest('details')!
    expect(details).toHaveTextContent('departure runway 27L')
    expect(details).toHaveTextContent('arrival runway 27R')
  })

  it('lists every arrival runway BeyondATC names', () => {
    const several = { ...beyondAtc, arrivalRunways: ['22L', '31L', '31R'] }
    render(<AtisLine answer={answer('destination', [several])} network={null} />)
    expect(screen.getByText('BeyondATC ATIS R · arrival runway 22L, 31L, 31R')).toBeInTheDocument()
  })

  it('shows only the letter when the text names no runway for the tab', () => {
    const none = { ...beyondAtc, arrivalRunways: [], departureRunways: [] }
    render(<AtisLine answer={answer('departure', [none])} network={null} />)
    expect(screen.getByText('BeyondATC ATIS R')).toBeInTheDocument()
  })

  it('has no trailing space when the ATIS has no letter', () => {
    render(<AtisLine answer={answer('departure', [{ ...beyondAtc, code: null }])} network={null} />)
    expect(screen.getByText('BeyondATC ATIS · departure runway 27L')).toBeInTheDocument()
  })

  it('draws the text as text, never as markup, folded until pressed', () => {
    render(<AtisLine answer={answer('departure', [beyondAtc])} network={null} />)
    const details = screen.getByText('BeyondATC ATIS R · departure runway 27L').closest('details')!
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent('<b>READBACK</b>')
    expect(details.querySelector('b')).toBeNull()
  })

  it("puts BeyondATC's line ahead of the network's, and keeps both", () => {
    render(<AtisLine answer={answer('destination', [beyondAtc, network])} network="vatsim" />)
    const lines = [...document.querySelectorAll('summary')].map((el) => el.textContent)
    expect(lines).toEqual(['BeyondATC ATIS R · arrival runway 27R', 'VATSIM arrival ATIS L · runway 27R'])
  })

  it("says BeyondATC's ATIS could not be read, above the network's line", () => {
    render(
      <AtisLine answer={answer('destination', [network], { beyondAtcUnavailable: true })} network="vatsim" />
    )
    expect(screen.getByText("BeyondATC's ATIS could not be read just now")).toBeInTheDocument()
    expect(screen.getByText('VATSIM arrival ATIS L · runway 27R')).toBeInTheDocument()
  })

  it('says it too with no network chosen, and shows nothing about the network', () => {
    render(<AtisLine answer={answer('destination', [], { beyondAtcUnavailable: true })} network={null} />)
    expect(screen.getByText("BeyondATC's ATIS could not be read just now")).toBeInTheDocument()
    expect(screen.queryByText(/VATSIM/)).not.toBeInTheDocument()
  })

  it('does not say "No VATSIM ATIS" beside BeyondATC\'s, since there is one', () => {
    render(<AtisLine answer={answer('departure', [beyondAtc])} network="vatsim" />)
    expect(screen.queryByText('No VATSIM ATIS')).not.toBeInTheDocument()
  })

  it('still says so when the network has none and BeyondATC could not be read', () => {
    render(<AtisLine answer={answer('departure', [], { beyondAtcUnavailable: true })} network="vatsim" />)
    expect(screen.getByText("BeyondATC's ATIS could not be read just now")).toBeInTheDocument()
    expect(screen.getByText('No VATSIM ATIS')).toBeInTheDocument()
  })

  it('shows nothing with no network, and nothing from BeyondATC', () => {
    const { container } = render(<AtisLine answer={answer('departure', [])} network={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('writes its labels in the active language', async () => {
    await i18n.changeLanguage('de')
    render(<AtisLine answer={answer('departure', [beyondAtc])} network={null} />)
    expect(screen.getByText('BeyondATC-ATIS R · Startbahn 27L')).toBeInTheDocument()
  })
})
