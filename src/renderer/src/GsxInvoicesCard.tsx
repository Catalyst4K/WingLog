/** A flight's GSX receipts card, with the total in the display currency. */

import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { FlightInvoice, GsxNotailCandidate } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { asyncHandler, runAsync } from './report-error'

function serviceGroupLabel(group: FlightInvoice['serviceGroup'], t: TFunction): string {
  return t(`gsxInvoicesCard.serviceGroup.${group}`)
}

interface ReceiptDetail {
  serviceInfoRows?: [string, string][]
  items?: { description: string; qty: string; unitPrice: string; amount: string }[]
  subtotal?: string
  taxes?: { label: string; rate: string; amount: string; reason: string }[]
  fxDisclosure?: string
}

/**
 * receiptJson is stored verbatim (minus logoDataUri) — parsed client-side only when the
 * row's detail is actually expanded. Empty object on anything unparseable rather than
 * throwing; a flight's other receipts shouldn't disappear because one JSON is malformed.
 *
 * @param receiptJson The stored receipt JSON.
 * @returns Its detail, or an empty object.
 */
function parseDetail(receiptJson: string): ReceiptDetail {
  try {
    return JSON.parse(receiptJson) as ReceiptDetail
  } catch {
    return {}
  }
}

/**
 * The UTC calendar date (YYYY-MM-DD) a receipt was issued on — the day whose exchange
 * rate its total should convert at, not today's.
 *
 * @param invoice The receipt.
 * @returns Its UTC issue date, YYYY-MM-DD.
 */
function receiptDate(invoice: FlightInvoice): string {
  return invoice.issuedUtc.slice(0, 10)
}

function rateKey(currency: string, date: string): string {
  return `${currency}:${date}`
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
}

/**
 * A receipt's amount as shown on its row. GSX's own text is `"<local> ~$ <USD>"`
 * (src/main/gsx/money.ts); when the card's total is in another display currency, the
 * `~$` half is swapped for that currency so every row matches the total underneath. The
 * local half stays verbatim. With no conversion (USD display, rate not resolved, no USD
 * amount), GSX's text is shown as-is.
 *
 * @param inv The receipt.
 * @param converted The display currency and its rate, or null.
 * @returns The amount text.
 */
function rowAmountText(inv: FlightInvoice, converted: { currency: string; rate: number } | null): string {
  if (inv.totalText == null) return '—'
  if (converted == null || inv.totalUsd == null) return inv.totalText
  const tildeIndex = inv.totalText.indexOf('~')
  const local = (tildeIndex === -1 ? inv.totalText : inv.totalText.slice(0, tildeIndex)).trim()
  return `${local} ~${formatMoney(inv.totalUsd * converted.rate, converted.currency)}`
}

/**
 * One receipt: a summary line, and its line items when opened. Shows the amount converted to the
 * display currency when there is a rate.
 *
 * @param props The invoice and the currency conversion to show, if any.
 * @returns The row.
 */
function InvoiceRow(props: {
  invoice: FlightInvoice
  converted: { currency: string; rate: number } | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const inv = props.invoice
  const detail = parseDetail(inv.receiptJson)

  return (
    <details className="group rounded-md border border-border p-2.5 text-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-foreground">
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
          {serviceGroupLabel(inv.serviceGroup, t)}
          {inv.operator ? ` — ${inv.operator}` : ''}
        </span>
        <span className="flex items-center gap-3">
          <span className="font-mono tabular-nums text-foreground">
            {rowAmountText(inv, props.converted)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              void window.winglog.gsxOpenReceipt(inv.sourceHtmlPath)
            }}
          >
            {t('gsxInvoicesCard.openReceipt')}
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

/**
 * The flight's matched GSX receipts, and the ones not matched by tail.
 *
 * @param props The flight.
 * @returns The element.
 */
export function GsxInvoicesCard(props: { flightId: number }): React.JSX.Element {
  const { t } = useTranslation()
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
    runAsync(
      'GsxInvoicesCard logbookListInvoices',
      window.winglog.logbookListInvoices(props.flightId).then(setInvoices)
    )
  }, [props.flightId])

  useEffect(() => {
    runAsync(
      'GsxInvoicesCard settingsGetGsx',
      window.winglog.settingsGetGsx().then((settings) => {
        setDisplayCurrency(settings.displayCurrency)
      })
    )
  }, [])

  useEffect(() => {
    if (displayCurrency === 'USD') return
    const dates = [...new Set(invoices.filter((inv) => inv.totalUsd != null).map(receiptDate))]
    const missing = dates.filter((date) => !rates.has(rateKey(displayCurrency, date)))
    if (missing.length === 0) return
    runAsync(
      'GsxInvoicesCard fxGetRate',
      Promise.all(missing.map((date) => window.winglog.fxGetRate(displayCurrency, date))).then((results) => {
        setRates((current) => {
          const next = new Map(current)
          missing.forEach((date, i) => next.set(rateKey(displayCurrency, date), results[i]))
          return next
        })
      })
    )
    // Re-runs whenever displayCurrency or the set of receipt dates changes; `rates` itself
    // isn't a dependency (only read via `missing`/`has`, never used to decide whether to
    // re-fetch a date already in flight) — including it would refetch on every response,
    // since each response is itself a `rates` update.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rates would refetch on every response
  }, [displayCurrency, invoices])

  async function handleRescan(): Promise<void> {
    setRescanning(true)
    try {
      const result = await window.winglog.gsxRescanFlight(props.flightId)
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
      const updated = await window.winglog.gsxAttachNotailReceipt(props.flightId, candidate.jsonPath)
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
  const convertedTotals = invoicesWithUsd.map((inv) => {
    const rate = rateFor(inv)
    return inv.totalUsd != null && rate != null ? inv.totalUsd * rate : null
  })
  const showConverted =
    displayCurrency !== 'USD' &&
    convertedTotals.length > 0 &&
    convertedTotals.every((total) => total !== null)
  const displayTotal = showConverted
    ? convertedTotals.reduce<number>((sum, total) => sum + (total ?? 0), 0)
    : totalUsd
  const displayCode = showConverted ? displayCurrency : 'USD'
  const formattedTotal = formatMoney(displayTotal, displayCode)
  // Rows convert on exactly the same condition as the total, so the card never mixes a
  // converted total with unconverted rows (or the reverse).
  const convertedFor = (inv: FlightInvoice): { currency: string; rate: number } | null => {
    const rate = rateFor(inv)
    return showConverted && inv.totalUsd != null && rate != null ? { currency: displayCurrency, rate } : null
  }

  return (
    <Card className="min-w-72 max-w-2xl flex-1">
      <CardHeader>
        <CardTitle className="text-sm">{t('gsxInvoicesCard.title')}</CardTitle>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={asyncHandler('GsxInvoicesCard handleRescan', handleRescan)}
            disabled={rescanning}
          >
            {rescanning ? t('gsxInvoicesCard.scanning') : t('gsxInvoicesCard.rescan')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('gsxInvoicesCard.empty')}</p>
        ) : (
          <>
            {invoices.map((inv) => (
              <InvoiceRow key={inv.id} invoice={inv} converted={convertedFor(inv)} />
            ))}
            {hasAnyUsdTotal && (
              <div className="flex justify-between border-t border-border pt-2 text-sm">
                <span className="text-muted-foreground">
                  {t('gsxInvoicesCard.total', { code: displayCode })}
                </span>
                <span className="font-mono tabular-nums text-foreground">{formattedTotal}</span>
              </div>
            )}
          </>
        )}

        {notailCandidates.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-border pt-2">
            <span className="text-xs text-muted-foreground">{t('gsxInvoicesCard.notailHint')}</span>
            {notailCandidates.map((c) => (
              <div key={c.jsonPath} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-foreground">
                  {serviceGroupLabel(c.serviceGroup, t)} · {c.icao} · {new Date(c.issuedUtc).toLocaleString()}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={asyncHandler('GsxInvoicesCard handleAttach', () => handleAttach(c))}
                >
                  {t('gsxInvoicesCard.attach')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
