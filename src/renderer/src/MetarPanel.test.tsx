import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AtisAnswer, AtisSlot, MetarReport, WeatherAtis, WingLogApi } from '@shared/ipc'
import i18n from './i18n'
import { MetarPanel } from './MetarPanel'

function withWinglog(overrides: Partial<WingLogApi> = {}): void {
  window.winglog = {
    airportSearch: vi.fn().mockResolvedValue([]),
    weatherGetMetars: vi.fn().mockResolvedValue([]),
    ...overrides
  } as unknown as WingLogApi
}

function report(overrides: Partial<MetarReport> & Pick<MetarReport, 'icao'>): MetarReport {
  return {
    rawText: `METAR ${overrides.icao} 012320Z AUTO 25008KT 9999 NCD 18/12 Q1020`,
    observedUtc: new Date().toISOString(),
    flightCategory: null,
    ...overrides
  }
}

describe('MetarPanel', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders its empty state and tab labels in the active i18next language, not a hardcoded English string', async () => {
    await i18n.changeLanguage('de')
    withWinglog()
    render(<MetarPanel depIcao={null} arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)
    expect(screen.getByText('Kein Flughafen festgelegt.')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Ziel' })).toBeInTheDocument()
  })

  it('shows "No airport set." for a slot with no ICAO, and does not fetch at all', async () => {
    const weatherGetMetars = vi.fn().mockResolvedValue([])
    withWinglog({ weatherGetMetars })
    render(<MetarPanel depIcao={null} arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(screen.getByText('No airport set.')).toBeInTheDocument()
    // Give the deferred fetch effect a chance to fire if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(weatherGetMetars).not.toHaveBeenCalled()
  })

  it('fetches METARs for whichever slots have a real 4-letter code', async () => {
    const weatherGetMetars = vi.fn().mockResolvedValue([report({ icao: 'EGLL' })])
    withWinglog({ weatherGetMetars })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    await waitFor(() => expect(weatherGetMetars).toHaveBeenCalledWith(['EGLL']))
  })

  it('shows "Fetching…" while the request is pending, then the report once it resolves', async () => {
    let resolveFetch: (reports: MetarReport[]) => void = () => {}
    const weatherGetMetars = vi.fn(
      () =>
        new Promise<MetarReport[]>((resolve) => {
          resolveFetch = resolve
        })
    )
    withWinglog({ weatherGetMetars })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText('Fetching…', {}, { timeout: 2000 })).toBeInTheDocument()
    resolveFetch([report({ icao: 'EGLL', flightCategory: 'VFR' })])
    await waitFor(() => expect(screen.queryByText('Fetching…')).not.toBeInTheDocument())
    expect(screen.getByText('VFR')).toBeInTheDocument()
  })

  it('shows "No current METAR for X" when the fetch resolves without a matching report', async () => {
    withWinglog({ weatherGetMetars: vi.fn().mockResolvedValue([]) })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText('No current METAR for EGLL.', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('renders the flight category tag and the parsed wind line when both are present', async () => {
    withWinglog({
      weatherGetMetars: vi.fn().mockResolvedValue([
        report({
          icao: 'EGLL',
          flightCategory: 'VFR',
          rawText: 'METAR EGLL 012320Z 25008KT 9999 NCD 18/12 Q1020'
        })
      ])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText('VFR', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByText(/Wind 250° at 8 kt/)).toBeInTheDocument()
    expect(screen.getByText('METAR EGLL 012320Z 25008KT 9999 NCD 18/12 Q1020')).toBeInTheDocument()
  })

  it('omits the wind line when the raw text has no recognisable wind group', async () => {
    withWinglog({
      weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', rawText: 'METAR EGLL NIL' })])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    await screen.findByText('METAR EGLL NIL', {}, { timeout: 2000 })
    expect(screen.queryByText(/Wind/)).not.toBeInTheDocument()
  })

  it('omits the flight-category tag when the report has none', async () => {
    withWinglog({
      weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', flightCategory: null })])
    })
    const { container } = render(
      <MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />
    )

    await screen.findByText(/METAR EGLL/, {}, { timeout: 2000 })
    for (const cat of ['VFR', 'MVFR', 'IFR', 'LIFR']) {
      expect(container).not.toHaveTextContent(cat)
    }
  })

  it.each(['MVFR', 'IFR', 'LIFR'] as const)('renders the %s flight-category tag', async (cat) => {
    withWinglog({
      weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', flightCategory: cat })])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText(cat, {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('formats "just now" for a report observed under a minute ago', async () => {
    withWinglog({
      weatherGetMetars: vi
        .fn()
        .mockResolvedValue([report({ icao: 'EGLL', observedUtc: new Date().toISOString() })])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText('just now', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('formats "N min ago" for a report observed several minutes ago', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    withWinglog({
      weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', observedUtc: fiveMinAgo })])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText('5 min ago', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('formats "N h ago" for a report observed over an hour ago', async () => {
    const twoHoursAgo = new Date(Date.now() - 130 * 60_000).toISOString()
    withWinglog({
      weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', observedUtc: twoHoursAgo })])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText('2 h ago', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('renders no "ago" text when observedUtc is empty', async () => {
    withWinglog({ weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', observedUtc: '' })]) })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    await screen.findByText(/METAR EGLL/, {}, { timeout: 2000 })
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
  })

  it('lets each of Dep/Dest/Altn/Custom show its own airport', async () => {
    const weatherGetMetars = vi
      .fn()
      .mockResolvedValue([report({ icao: 'EGLL' }), report({ icao: 'KJFK' }), report({ icao: 'EGKK' })])
    withWinglog({ weatherGetMetars })
    const user = userEvent.setup()
    render(<MetarPanel depIcao="EGLL" arrIcao="KJFK" altnIcao="EGKK" windSpeedUnit="kt" />)

    await waitFor(() => expect(weatherGetMetars).toHaveBeenCalled())
    expect(await screen.findByText(/METAR EGLL/, {}, { timeout: 2000 })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Dest' }))
    expect(await screen.findByText(/METAR KJFK/, {}, { timeout: 2000 })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Altn' }))
    expect(await screen.findByText(/METAR EGKK/, {}, { timeout: 2000 })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Custom' }))
    expect(screen.getByText('No airport set.')).toBeInTheDocument()
  }, 10000)

  it('debounces the custom-tab ICAO before fetching, and shows its own result', async () => {
    const weatherGetMetars = vi.fn().mockResolvedValue([report({ icao: 'ZZZZ' })])
    withWinglog({ weatherGetMetars })
    const user = userEvent.setup()
    render(<MetarPanel depIcao={null} arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    await user.click(screen.getByRole('tab', { name: 'Custom' }))
    await user.type(screen.getByPlaceholderText('Enter an ICAO code'), 'zzzz')

    await waitFor(() => expect(weatherGetMetars).toHaveBeenCalledWith(['ZZZZ']), { timeout: 2000 })
    expect(await screen.findByText(/METAR ZZZZ/, {}, { timeout: 2000 })).toBeInTheDocument()
  }, 10000)

  it('re-fetches when the refresh button is clicked', async () => {
    const weatherGetMetars = vi.fn().mockResolvedValue([report({ icao: 'EGLL' })])
    withWinglog({ weatherGetMetars })
    const user = userEvent.setup()
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    await waitFor(() => expect(weatherGetMetars).toHaveBeenCalledTimes(1))
    await user.click(screen.getByTitle('Refresh METAR'))

    await waitFor(() => expect(weatherGetMetars).toHaveBeenCalledTimes(2))
  })

  it('ignores a fetch that resolves after the component has unmounted', async () => {
    let resolveFetch: (reports: MetarReport[]) => void = () => {}
    const weatherGetMetars = vi.fn(
      () =>
        new Promise<MetarReport[]>((resolve) => {
          resolveFetch = resolve
        })
    )
    withWinglog({ weatherGetMetars })
    const { unmount } = render(
      <MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />
    )

    await waitFor(() => expect(weatherGetMetars).toHaveBeenCalled())
    unmount()
    resolveFetch([report({ icao: 'EGLL' })])
    // Nothing to assert on screen (it's unmounted) — this just proves the cancellation
    // guard runs without throwing an act() warning turning into a failure.
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('uses mps wind display when windSpeedUnit is "mps"', async () => {
    withWinglog({
      weatherGetMetars: vi
        .fn()
        .mockResolvedValue([
          report({ icao: 'EGLL', rawText: 'METAR EGLL 012320Z 25008KT 9999 NCD 18/12 Q1020' })
        ])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="mps" />)

    expect(await screen.findByText(/Wind 250° at 4 m\/s/, {}, { timeout: 2000 })).toBeInTheDocument()
  })
})

describe('MetarPanel: the live ATIS', () => {
  const answer = (
    airports: AtisAnswer['airports'],
    network: AtisAnswer['network'] = 'vatsim'
  ): AtisAnswer => ({
    network,
    airports
  })
  const shown = (icao: string, slot: AtisSlot, atis: WeatherAtis[]): AtisAnswer['airports'][number] => ({
    icao,
    slot,
    state: 'shown',
    atis
  })
  const departure: WeatherAtis = {
    callsign: 'EGLL_D_ATIS',
    code: 'L',
    kind: 'departure',
    lines: ['DEPARTURE INFORMATION LIMA', '<b>RUNWAY 27R IN USE</b>'],
    runway: '27R'
  }
  const arrival: WeatherAtis = {
    callsign: 'EGLL_A_ATIS',
    code: 'M',
    kind: 'arrival',
    lines: ['ARRIVAL INFORMATION MIKE'],
    runway: null
  }

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('asks with the METARs for each tab that has an airport, naming the tab, and shows the departure ATIS folded under the METAR', async () => {
    const onlineAtisGet = vi
      .fn()
      .mockResolvedValue(
        answer([shown('EGLL', 'departure', [departure]), shown('LFPG', 'destination', [arrival])])
      )
    withWinglog({ onlineAtisGet, weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL' })]) })
    render(<MetarPanel depIcao="egll" arrIcao="LFPG" altnIcao={null} windSpeedUnit="kt" />)

    await waitFor(() =>
      expect(onlineAtisGet).toHaveBeenCalledWith([
        { icao: 'EGLL', slot: 'departure' },
        { icao: 'LFPG', slot: 'destination' }
      ])
    )
    const summary = await screen.findByText('VATSIM departure ATIS L · runway 27R')
    const details = summary.closest('details')!
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent('EGLL_D_ATIS')
    expect(details).toHaveTextContent('Runway in use (from the ATIS): 27R')
    // Drawn as text: the markup in the ATIS is shown, never made.
    expect(details).toHaveTextContent('<b>RUNWAY 27R IN USE</b>')
    expect(details.querySelector('b')).toBeNull()
  })

  it('shows the arrival ATIS on the destination tab, naming what it is', async () => {
    withWinglog({
      onlineAtisGet: vi.fn().mockResolvedValue(answer([shown('EGLL', 'destination', [arrival])]))
    })
    render(<MetarPanel depIcao={null} arrIcao="EGLL" altnIcao={null} windSpeedUnit="kt" />)
    await userEvent.click(screen.getByRole('tab', { name: 'Dest' }))
    expect(await screen.findByText('VATSIM arrival ATIS M')).toBeInTheDocument()
  })

  it('names IVAO, and has no trailing space when an ATIS has no letter', async () => {
    const noLetter: WeatherAtis = { ...departure, code: null, kind: 'single', runway: null }
    withWinglog({
      onlineAtisGet: vi.fn().mockResolvedValue(answer([shown('EGLL', 'departure', [noLetter])], 'ivao'))
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)
    expect(await screen.findByText('IVAO ATIS')).toBeInTheDocument()
  })

  it('says so when no ATIS is online at the airport, and when the network could not be read', async () => {
    withWinglog({
      onlineAtisGet: vi.fn().mockResolvedValue(
        answer([
          { icao: 'EGLL', slot: 'departure', state: 'none', atis: [] },
          { icao: 'LFPG', slot: 'destination', state: 'unavailable', atis: [] }
        ])
      )
    })
    render(<MetarPanel depIcao="EGLL" arrIcao="LFPG" altnIcao={null} windSpeedUnit="kt" />)
    expect(await screen.findByText('No VATSIM ATIS')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Dest' }))
    expect(await screen.findByText('VATSIM ATIS unavailable')).toBeInTheDocument()
  })

  it('shows nothing about ATIS with no network chosen, and the METAR is unaffected', async () => {
    withWinglog({
      onlineAtisGet: vi.fn().mockResolvedValue(answer([], null)),
      weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL' })])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)
    expect(await screen.findByText(/METAR EGLL/)).toBeInTheDocument()
    expect(screen.queryByText(/ATIS/)).not.toBeInTheDocument()
  })

  it('does not ask at all while no tab has an airport', async () => {
    const onlineAtisGet = vi.fn().mockResolvedValue(answer([]))
    withWinglog({ onlineAtisGet })
    render(<MetarPanel depIcao={null} arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onlineAtisGet).not.toHaveBeenCalled()
  })

  it('asks again when Refresh is pressed', async () => {
    const onlineAtisGet = vi.fn().mockResolvedValue(answer([shown('EGLL', 'departure', [departure])]))
    withWinglog({ onlineAtisGet })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)
    await waitFor(() => expect(onlineAtisGet).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByTitle('Refresh METAR'))
    await waitFor(() => expect(onlineAtisGet).toHaveBeenCalledTimes(2))
  })

  it('does not show an answer meant for another airport on a tab', async () => {
    const other: WeatherAtis = {
      ...departure,
      callsign: 'EGKK_ATIS',
      code: 'B',
      kind: 'single',
      runway: null
    }
    const onlineAtisGet = vi.fn().mockResolvedValue(answer([shown('EGKK', 'departure', [other])]))
    withWinglog({ onlineAtisGet })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)
    await waitFor(() => expect(onlineAtisGet).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText('VATSIM ATIS B')).not.toBeInTheDocument()
  })

  it("shows BeyondATC's ATIS with its runway for the tab, with no network chosen, and asks again when Refresh is pressed", async () => {
    const beyondAtc: WeatherAtis = {
      callsign: 'BeyondATC',
      code: 'R',
      kind: 'single',
      lines: ['EGLL ATIS R 2338Z ARR RWY 27 RIGHT DEP RWY 27 LEFT'],
      runway: null,
      source: 'beyondatc',
      arrivalRunways: ['27R'],
      departureRunways: ['27L']
    }
    const onlineAtisGet = vi
      .fn()
      .mockResolvedValue(
        answer(
          [
            shown('WSSS', 'departure', [{ ...beyondAtc, departureRunways: ['20C'] }]),
            shown('EGLL', 'destination', [beyondAtc])
          ],
          null
        )
      )
    withWinglog({ onlineAtisGet, weatherGetMetars: vi.fn().mockResolvedValue([]) })
    render(<MetarPanel depIcao="WSSS" arrIcao="EGLL" altnIcao={null} windSpeedUnit="kt" />)
    expect(await screen.findByText('BeyondATC ATIS R · departure runway 20C')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Dest' }))
    expect(await screen.findByText('BeyondATC ATIS R · arrival runway 27R')).toBeInTheDocument()
    expect(onlineAtisGet).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: /Refresh/ }))
    await waitFor(() => expect(onlineAtisGet).toHaveBeenCalledTimes(2))
  })

  it('carries on without an ATIS when the screen has no lookup for it', async () => {
    withWinglog({ weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL' })]) })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)
    expect(await screen.findByText(/METAR EGLL/)).toBeInTheDocument()
  })

  it('writes its labels in the active language', async () => {
    await i18n.changeLanguage('de')
    withWinglog({
      onlineAtisGet: vi.fn().mockResolvedValue(answer([shown('EGLL', 'departure', [departure])]))
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)
    expect(await screen.findByText('VATSIM Abflug-ATIS L · Piste 27R')).toBeInTheDocument()
  })
})
