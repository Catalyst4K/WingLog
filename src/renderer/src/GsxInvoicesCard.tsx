import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { FlightInvoice, GsxNotailCandidate } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const SERVICE_GROUP_LABEL: Record<FlightInvoice['serviceGroup'], string> = {
  catering: 'Catering',
  fuel: 'Fuel',
  handling: 'Handling',
  passengerBus: 'Passenger bus'
}

interface ReceiptDetail {
  serviceInfoRows?: [string, string][]
  items?: { description: string; qty: string; unitPrice: string; amount: string }[]
  subtotal?: string
  taxes?: { label: string; rate: string; amount: string; reason: string }[]
  fxDisclosure?: string
}

/** receiptJson is stored verbatim (minus logoDataUri) — parsed client-side only when the
 *  row's detail is actually expanded. Empty object on anything unparseable rather than
 *  throwing; a flight's other receipts shouldn't disappear because one JSON is malformed. */
function parseDetail(receiptJson: string): ReceiptDetail {
  try {
    return JSON.parse(receiptJson) as ReceiptDetail
  } catch {
    return {}
  }
}

/** The UTC calendar date (YYYY-MM-DD) a receipt was issued on — the day whose exchange
 *  rate its total should convert at, not today's. */
function receiptDate(invoice: FlightInvoice): string {
  return invoice.issuedUtc.slice(0, 10)
}

function rateKey(currency: string, date: string): string {
  return `${currency}:${date}`
}

function InvoiceRow(props: { invoice: FlightInvoice }): React.JSX.Element {
  const inv = props.invoice
  const detail = parseDetail(inv.receiptJson)

  return (
    <details className="rounded-md border border-border p-2.5 text-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="text-foreground">
          {SERVICE_GROUP_LABEL[inv.serviceGroup]}
          {inv.operator ? ` — ${inv.operator}` : ''}
        </span>
        <span className="flex items-center gap-3">
          <span className="font-mono tabular-nums text-foreground">{inv.totalText ?? '—'}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              void window.flightdeck.gsxOpenReceipt(inv.sourceHtmlPath)
            }}
          >
            Open receipt
          </Button>
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
        {detail.serviceInfoRows && detail.serviceInfoRows.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            {detail.serviceInfoRows.map(([label, value], i) => (
              <div key={i} className="contents">
                <dt>{label}</dt>
                <dd className="text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {detail.items && detail.items.length > 0 && (
          <ul className="flex flex-col gap-1">
            {detail.items.map((item, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="whitespace-pre-line">{item.description}</span>
                <span className="font-mono tabular-nums text-foreground">{item.amount}</span>
              </li>
            ))}
          </ul>
        )}
        {detail.taxes?.map((tax, i) => (
          <div key={i} className="flex justify-between gap-3">
            <span>
              {tax.label} ({tax.rate}){tax.reason ? ` — ${tax.reason}` : ''}
            </span>
            <span className="font-mono tabular-nums text-foreground">{tax.amount}</span>
          </div>
        ))}
        {detail.fxDisclosure && <p>{detail.fxDisclosure}</p>}
      </div>
    </details>
  )
}

export function GsxInvoicesCard(props: { flightId: number }): React.JSX.Element {
  const [invoices, setInvoices] = useState<FlightInvoice[]>([])
  const [notailCandidates, setNotailCandidates] = useState<GsxNotailCandidate[]>([])
  const [rescanning, setRescanning] = useState(false)
  const [displayCurrency, setDisplayCurrency] = useState('USD')
  // Keyed by "currency:date" (date = receipt-issued YYYY-MM-DD) — converting at the rate
  // that applied on the day each receipt was actually issued, not today's rate. A
  // missing/null entry means that key's rate hasn't resolved yet (still loading, or the
  // lookup failed). Keying on currency too means switching currencies never reuses a
  // stale rate from the previous one.
  const [rates, setRates] = useState<Map<string, number | null>>(new Map())

  useEffect(() => {
    window.flightdeck.logbookListInvoices(props.flightId).then(setInvoices)
  }, [props.flightId])

  useEffect(() => {
    window.flightdeck.settingsGetGsx().then((settings) => {
      setDisplayCurrency(settings.displayCurrency)
    })
  }, [])

  useEffect(() => {
    if (displayCurrency === 'USD') return
    const dates = [...new Set(invoices.filter((inv) => inv.totalUsd != null).map(receiptDate))]
    const missing = dates.filter((date) => !rates.has(rateKey(displayCurrency, date)))
    if (missing.length === 0) return
    Promise.all(missing.map((date) => window.flightdeck.fxGetRate(displayCurrency, date))).then((results) => {
      setRates((current) => {
        const next = new Map(current)
        missing.forEach((date, i) => next.set(rateKey(displayCurrency, date), results[i]))
        return next
      })
    })
    // Re-runs whenever displayCurrency or the set of receipt dates changes; `rates` itself
    // isn't a dependency (only read via `missing`/`has`, never used to decide whether to
    // re-fetch a date already in flight) — including it would refetch on every response,
    // since each response is itself a `rates` update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayCurrency, invoices])

  async function handleRescan(): Promise<void> {
    setRescanning(true)
    try {
      const result = await window.flightdeck.gsxRescanFlight(props.flightId)
      setInvoices(result.invoices)
      setNotailCandidates(result.notailCandidates)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRescanning(false)
    }
  }

  async function handleAttach(candidate: GsxNotailCandidate): Promise<void> {
    try {
      const updated = await window.flightdeck.gsxAttachNotailReceipt(props.flightId, candidate.jsonPath)
      setInvoices(updated)
      setNotailCandidates((current) => current.filter((c) => c.jsonPath !== candidate.jsonPath))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const totalUsd = invoices.reduce((sum, inv) => sum + (inv.totalUsd ?? 0), 0)
  const hasAnyUsdTotal = invoices.some((inv) => inv.totalUsd != null)
  const invoicesWithUsd = invoices.filter((inv) => inv.totalUsd != null)
  const rateFor = (inv: FlightInvoice): number | null | undefined =>
    rates.get(rateKey(displayCurrency, receiptDate(inv)))
  // Falls back to showing the plain USD total whenever ANY receipt's rate hasn't resolved
  // yet (still loading, or that date's lookup failed) — never a total that's silently
  // converted for some receipts and not others.
  const showConverted =
    displayCurrency !== 'USD' && invoicesWithUsd.length > 0 && invoicesWithUsd.every((inv) => rateFor(inv) != null)
  const displayTotal = showConverted
    ? invoicesWithUsd.reduce((sum, inv) => sum + inv.totalUsd! * rateFor(inv)!, 0)
    : totalUsd
  const displayCode = showConverted ? displayCurrency : 'USD'
  const formattedTotal = new Intl.NumberFormat(undefined, { style: 'currency', currency: displayCode }).format(
    displayTotal
  )

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle className="text-sm">Ground services</CardTitle>
        <CardAction>
          <Button type="button" variant="outline" size="sm" onClick={handleRescan} disabled={rescanning}>
            {rescanning ? 'Scanning…' : 'Rescan'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No GSX receipts matched to this flight yet — enable GSX in Settings and rescan.
          </p>
        ) : (
          <>
            {invoices.map((inv) => (
              <InvoiceRow key={inv.id} invoice={inv} />
            ))}
            {hasAnyUsdTotal && (
              <div className="flex justify-between border-t border-border pt-2 text-sm">
                <span className="text-muted-foreground">Total ({displayCode})</span>
                <span className="font-mono tabular-nums text-foreground">{formattedTotal}</span>
              </div>
            )}
          </>
        )}

        {notailCandidates.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-border pt-2">
            <span className="text-xs text-muted-foreground">
              Possibly this flight — tail unknown on the receipt, so not attached automatically:
            </span>
            {notailCandidates.map((c) => (
              <div key={c.jsonPath} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-foreground">
                  {SERVICE_GROUP_LABEL[c.serviceGroup]} · {c.icao} · {new Date(c.issuedUtc).toLocaleString()}
                </span>
                <Button type="button" variant="outline" size="sm" onClick={() => handleAttach(c)}>
                  Attach
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
