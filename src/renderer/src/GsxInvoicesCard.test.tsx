import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FlightInvoice, GsxNotailCandidate, GsxSettings, WingLogApi } from '@shared/ipc'
import { GsxInvoicesCard } from './GsxInvoicesCard'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
import { toast } from 'sonner'

const GSX_SETTINGS_USD: GsxSettings = { enabled: true, folderPath: '/gsx', displayCurrency: 'USD' }

function invoice(overrides: Partial<FlightInvoice> = {}): FlightInvoice {
  return {
    id: 1,
    flightId: 42,
    serviceGroup: 'fuel',
    receiptId: 'r1',
    issuedUtc: '2026-09-01T12:00:00.000Z',
    icao: 'EGLL',
    tail: 'G-TEST',
    operator: null,
    totalUsd: 100,
    totalText: '$100.00',
    sourceHtmlPath: '/receipts/r1.html',
    receiptJson: '{}',
    ...overrides
  }
}

function withWinglog(overrides: Partial<WingLogApi> = {}): WingLogApi {
  const api = {
    logbookListInvoices: vi.fn().mockResolvedValue([]),
    settingsGetGsx: vi.fn().mockResolvedValue(GSX_SETTINGS_USD),
    fxGetRate: vi.fn().mockResolvedValue(null),
    gsxRescanFlight: vi.fn().mockResolvedValue({ invoices: [], notailCandidates: [] }),
    gsxAttachNotailReceipt: vi.fn().mockResolvedValue([]),
    gsxOpenReceipt: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as WingLogApi
  window.winglog = api
  return api
}

describe('GsxInvoicesCard', () => {
  it('shows the empty-state message when there are no invoices', async () => {
    withWinglog()
    render(<GsxInvoicesCard flightId={42} />)

    expect(await screen.findByText(/No GSX receipts matched to this flight yet/)).toBeInTheDocument()
  })

  it('loads invoices for the given flight and renders each one', async () => {
    withWinglog({
      logbookListInvoices: vi.fn().mockResolvedValue([
        invoice({ id: 1, serviceGroup: 'catering', operator: 'Acme Catering' }),
        invoice({ id: 2, serviceGroup: 'handling', totalText: null })
      ])
    })
    render(<GsxInvoicesCard flightId={42} />)

    expect(await screen.findByText('Catering — Acme Catering')).toBeInTheDocument()
    expect(screen.getByText('Handling')).toBeInTheDocument()
    // The second invoice has no totalText, so it falls back to an em dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('re-fetches when flightId changes', async () => {
    const logbookListInvoices = vi.fn().mockResolvedValue([])
    withWinglog({ logbookListInvoices })
    const { rerender } = render(<GsxInvoicesCard flightId={1} />)
    await waitFor(() => expect(logbookListInvoices).toHaveBeenCalledWith(1))

    rerender(<GsxInvoicesCard flightId={2} />)
    await waitFor(() => expect(logbookListInvoices).toHaveBeenCalledWith(2))
  })

  it('opens a receipt without toggling the disclosure open', async () => {
    const gsxOpenReceipt = vi.fn().mockResolvedValue(undefined)
    withWinglog({
      logbookListInvoices: vi.fn().mockResolvedValue([invoice({ sourceHtmlPath: '/receipts/abc.html' })]),
      gsxOpenReceipt
    })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    const button = await screen.findByText('Open receipt')
    await user.click(button)

    expect(gsxOpenReceipt).toHaveBeenCalledWith('/receipts/abc.html')
    expect(button.closest('details')).not.toHaveAttribute('open')
  })

  it('expands a row to show service info rows, items, taxes and the fx disclosure', async () => {
    const receiptJson = JSON.stringify({
      serviceInfoRows: [['Truck', 'GSX-1']],
      items: [{ description: 'Jet A-1', qty: '100 gal', unitPrice: '$5', amount: '$500' }],
      taxes: [
        { label: 'VAT', rate: '20%', amount: '$100', reason: 'EU fuel duty' },
        { label: 'Handling fee', rate: '5%', amount: '$25', reason: '' }
      ],
      fxDisclosure: 'Converted at today\'s rate.'
    })
    withWinglog({ logbookListInvoices: vi.fn().mockResolvedValue([invoice({ receiptJson })]) })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    const summary = await screen.findByText('Fuel')
    await user.click(summary)

    expect(screen.getByText('Truck')).toBeInTheDocument()
    expect(screen.getByText('GSX-1')).toBeInTheDocument()
    expect(screen.getByText('Jet A-1')).toBeInTheDocument()
    expect(screen.getByText('$500')).toBeInTheDocument()
    expect(screen.getByText(/VAT \(20%\) — EU fuel duty/)).toBeInTheDocument()
    expect(screen.getByText("Converted at today's rate.")).toBeInTheDocument()
  })

  it('renders nothing extra in the expanded detail when the receipt JSON has no detail fields', async () => {
    withWinglog({ logbookListInvoices: vi.fn().mockResolvedValue([invoice({ receiptJson: '{}' })]) })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    const summary = await screen.findByText('Fuel')
    await user.click(summary)

    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('degrades to an empty detail rather than throwing on malformed receipt JSON', async () => {
    withWinglog({ logbookListInvoices: vi.fn().mockResolvedValue([invoice({ receiptJson: 'not json' })]) })
    render(<GsxInvoicesCard flightId={42} />)

    expect(await screen.findByText('Fuel')).toBeInTheDocument()
  })

  it('shows a plain USD total when every invoice has one', async () => {
    withWinglog({
      logbookListInvoices: vi.fn().mockResolvedValue([invoice({ id: 1, totalUsd: 100 }), invoice({ id: 2, totalUsd: 50 })])
    })
    render(<GsxInvoicesCard flightId={42} />)

    expect(await screen.findByText('Total (USD)')).toBeInTheDocument()
    expect(screen.getByText(/150\.00/)).toBeInTheDocument()
  })

  it('omits the total row entirely when no invoice has a USD total', async () => {
    withWinglog({ logbookListInvoices: vi.fn().mockResolvedValue([invoice({ totalUsd: null })]) })
    render(<GsxInvoicesCard flightId={42} />)

    await screen.findByText('Fuel')
    expect(screen.queryByText(/^Total/)).not.toBeInTheDocument()
  })

  it('converts the total using a resolved fx rate once display currency is non-USD', async () => {
    const fxGetRate = vi.fn().mockResolvedValue(0.8)
    withWinglog({
      logbookListInvoices: vi.fn().mockResolvedValue([invoice({ totalUsd: 100, issuedUtc: '2026-09-01T00:00:00Z' })]),
      settingsGetGsx: vi.fn().mockResolvedValue({ enabled: true, folderPath: null, displayCurrency: 'GBP' }),
      fxGetRate
    })
    render(<GsxInvoicesCard flightId={42} />)

    await waitFor(() => expect(fxGetRate).toHaveBeenCalledWith('GBP', '2026-09-01'))
    expect(await screen.findByText('Total (GBP)')).toBeInTheDocument()
    expect(screen.getByText(/80\.00/)).toBeInTheDocument()
  })

  it('falls back to the plain USD total when the fx rate for a receipt is still missing', async () => {
    withWinglog({
      logbookListInvoices: vi.fn().mockResolvedValue([invoice({ totalUsd: 100 })]),
      settingsGetGsx: vi.fn().mockResolvedValue({ enabled: true, folderPath: null, displayCurrency: 'GBP' }),
      fxGetRate: vi.fn().mockResolvedValue(null)
    })
    render(<GsxInvoicesCard flightId={42} />)

    const totalLabel = await screen.findByText('Total (USD)')
    expect(totalLabel.parentElement).toHaveTextContent('$100.00')
  })

  it('does not re-fetch a rate it has already resolved for the same currency and date', async () => {
    const fxGetRate = vi.fn().mockResolvedValue(0.8)
    const gsxRescanFlight = vi.fn().mockResolvedValue({
      invoices: [
        invoice({ id: 1, totalUsd: 100, issuedUtc: '2026-09-01T00:00:00Z' }),
        invoice({ id: 2, totalUsd: 50, issuedUtc: '2026-09-01T06:00:00Z' })
      ],
      notailCandidates: []
    })
    withWinglog({
      logbookListInvoices: vi.fn().mockResolvedValue([invoice({ id: 1, totalUsd: 100, issuedUtc: '2026-09-01T00:00:00Z' })]),
      settingsGetGsx: vi.fn().mockResolvedValue({ enabled: true, folderPath: null, displayCurrency: 'GBP' }),
      fxGetRate,
      gsxRescanFlight
    })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    await waitFor(() => expect(screen.getByText('Total (GBP)')).toBeInTheDocument())
    expect(fxGetRate).toHaveBeenCalledTimes(1)

    // A rescan swaps in a new invoices array with a second invoice — same UTC calendar
    // date as the first (already resolved) — so the effect must recompute `missing` as
    // empty and return early rather than re-fetching that rate.
    await user.click(screen.getByText('Rescan'))
    await waitFor(() => expect(screen.getByText(/120\.00/)).toBeInTheDocument())
    expect(fxGetRate).toHaveBeenCalledTimes(1)
  })

  it('rescans and replaces the invoice list on success', async () => {
    const rescanned = [invoice({ id: 9, serviceGroup: 'passengerBus' })]
    let resolveRescan: (result: { invoices: FlightInvoice[]; notailCandidates: GsxNotailCandidate[] }) => void = () => {}
    const gsxRescanFlight = vi.fn(
      () =>
        new Promise<{ invoices: FlightInvoice[]; notailCandidates: GsxNotailCandidate[] }>((resolve) => {
          resolveRescan = resolve
        })
    )
    withWinglog({ gsxRescanFlight })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    await screen.findByText(/No GSX receipts matched/)
    await user.click(screen.getByText('Rescan'))
    expect(await screen.findByText('Scanning…')).toBeInTheDocument()
    expect(screen.getByText('Scanning…').closest('button')).toBeDisabled()

    resolveRescan({ invoices: rescanned, notailCandidates: [] })

    expect(await screen.findByText('Passenger bus')).toBeInTheDocument()
    expect(gsxRescanFlight).toHaveBeenCalledWith(42)
    expect(screen.getByText('Rescan')).not.toBeDisabled()
  })

  it('shows an Error-derived message via toast when rescanning fails', async () => {
    withWinglog({ gsxRescanFlight: vi.fn().mockRejectedValue(new Error('scan blew up')) })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    await screen.findByText(/No GSX receipts matched/)
    await user.click(screen.getByText('Rescan'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('scan blew up'))
    expect(screen.getByText('Rescan')).toBeInTheDocument()
  })

  it('stringifies a non-Error rejection via toast when rescanning fails', async () => {
    withWinglog({ gsxRescanFlight: vi.fn().mockRejectedValue('nope') })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    await screen.findByText(/No GSX receipts matched/)
    await user.click(screen.getByText('Rescan'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'))
  })

  it('lists NOTAIL candidates and attaches one on click', async () => {
    const candidate: GsxNotailCandidate = {
      serviceGroup: 'fuel',
      jsonPath: '/notail/1.json',
      issuedUtc: '2026-09-01T12:00:00.000Z',
      icao: 'EGLL'
    }
    const attached = [invoice({ id: 5 })]
    const gsxAttachNotailReceipt = vi.fn().mockResolvedValue(attached)
    withWinglog({
      gsxRescanFlight: vi.fn().mockResolvedValue({ invoices: [], notailCandidates: [candidate] }),
      gsxAttachNotailReceipt
    })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    await screen.findByText(/No GSX receipts matched/)
    await user.click(screen.getByText('Rescan'))
    expect(await screen.findByText(/Fuel · EGLL ·/)).toBeInTheDocument()

    await user.click(screen.getByText('Attach'))

    expect(gsxAttachNotailReceipt).toHaveBeenCalledWith(42, '/notail/1.json')
    await waitFor(() => expect(screen.queryByText(/Fuel · EGLL ·/)).not.toBeInTheDocument())
    expect(await screen.findByText('Fuel')).toBeInTheDocument()
  })

  it('shows a toast and keeps the candidate listed when attaching fails', async () => {
    const candidate: GsxNotailCandidate = {
      serviceGroup: 'handling',
      jsonPath: '/notail/2.json',
      issuedUtc: '2026-09-01T12:00:00.000Z',
      icao: 'KJFK'
    }
    withWinglog({
      gsxRescanFlight: vi.fn().mockResolvedValue({ invoices: [], notailCandidates: [candidate] }),
      gsxAttachNotailReceipt: vi.fn().mockRejectedValue(new Error('attach failed'))
    })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    await screen.findByText(/No GSX receipts matched/)
    await user.click(screen.getByText('Rescan'))
    await screen.findByText(/Handling · KJFK ·/)

    await user.click(screen.getByText('Attach'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('attach failed'))
    expect(screen.getByText(/Handling · KJFK ·/)).toBeInTheDocument()
  })

  it('stringifies a non-Error rejection via toast when attaching fails', async () => {
    const candidate: GsxNotailCandidate = {
      serviceGroup: 'catering',
      jsonPath: '/notail/3.json',
      issuedUtc: '2026-09-01T12:00:00.000Z',
      icao: 'LFPG'
    }
    withWinglog({
      gsxRescanFlight: vi.fn().mockResolvedValue({ invoices: [], notailCandidates: [candidate] }),
      gsxAttachNotailReceipt: vi.fn().mockRejectedValue('rejected')
    })
    const user = userEvent.setup()
    render(<GsxInvoicesCard flightId={42} />)

    await screen.findByText(/No GSX receipts matched/)
    await user.click(screen.getByText('Rescan'))
    await screen.findByText(/Catering · LFPG ·/)

    await user.click(screen.getByText('Attach'))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rejected'))
  })
})
