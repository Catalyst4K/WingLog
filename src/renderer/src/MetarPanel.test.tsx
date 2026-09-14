import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MetarReport, WingLogApi } from '@shared/ipc'
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
      weatherGetMetars: vi
        .fn()
        .mockResolvedValue([report({ icao: 'EGLL', flightCategory: 'VFR', rawText: 'METAR EGLL 012320Z 25008KT 9999 NCD 18/12 Q1020' })])
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
    const { container } = render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    await screen.findByText(/METAR EGLL/, {}, { timeout: 2000 })
    for (const cat of ['VFR', 'MVFR', 'IFR', 'LIFR']) {
      expect(container).not.toHaveTextContent(cat)
    }
  })

  it.each(['MVFR', 'IFR', 'LIFR'] as const)('renders the %s flight-category tag', async (cat) => {
    withWinglog({ weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', flightCategory: cat })]) })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText(cat, {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('formats "just now" for a report observed under a minute ago', async () => {
    withWinglog({
      weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', observedUtc: new Date().toISOString() })])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText('just now', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('formats "N min ago" for a report observed several minutes ago', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()
    withWinglog({ weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', observedUtc: fiveMinAgo })]) })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

    expect(await screen.findByText('5 min ago', {}, { timeout: 2000 })).toBeInTheDocument()
  })

  it('formats "N h ago" for a report observed over an hour ago', async () => {
    const twoHoursAgo = new Date(Date.now() - 130 * 60_000).toISOString()
    withWinglog({ weatherGetMetars: vi.fn().mockResolvedValue([report({ icao: 'EGLL', observedUtc: twoHoursAgo })]) })
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
    const weatherGetMetars = vi.fn().mockResolvedValue([
      report({ icao: 'EGLL' }),
      report({ icao: 'KJFK' }),
      report({ icao: 'EGKK' })
    ])
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
    const { unmount } = render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="kt" />)

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
        .mockResolvedValue([report({ icao: 'EGLL', rawText: 'METAR EGLL 012320Z 25008KT 9999 NCD 18/12 Q1020' })])
    })
    render(<MetarPanel depIcao="EGLL" arrIcao={null} altnIcao={null} windSpeedUnit="mps" />)

    expect(await screen.findByText(/Wind 250° at 4 m\/s/, {}, { timeout: 2000 })).toBeInTheDocument()
  })
})
