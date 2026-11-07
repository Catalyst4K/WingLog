/** The Logbook's flights tab and the totals above it. */

import { useTranslation } from 'react-i18next'
import type { LogbookFlight, LogbookStats, WeightUnit } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { AirlineLogo } from '../AirlineLogo'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { displayIcao } from '../display-icao'
import { LandingScoreBadge } from '../LandingScoreBadge'
import { SortableHead } from '../SortableHead'
import { formatMinutes, formatWeight } from '../units'
import { LogbookRowsSkeleton } from './LandingsTable'
import { formatDate, isFreeFlight } from './logbook-format'
import { sortColumns, type SortKey } from './sorting'

/**
 * The totals above the tables: flights, hours and miles flown.
 *
 * @param props The stats (null until they load) and how many flights are listed.
 * @returns The element.
 */
export function LogbookStatsStrip(props: {
  stats: LogbookStats | null
  flightCount: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const { stats } = props
  // v2: one quiet line, the figures in the mono face, no uppercase labels (winglog-backend docs/plans/v2-design.md).
  const stat = (value: string | number, label: string): React.JSX.Element => (
    <span>
      <span className="font-mono text-foreground">{value}</span> <span>{label}</span>
    </span>
  )
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {stat(stats?.totalFlights ?? props.flightCount, t('fleetView.sortColumns.flights').toLowerCase())}
      <span aria-hidden="true">·</span>
      {stat(
        formatMinutes(stats?.totalBlockMinutes ?? null),
        t('logbookView.sortColumns.block').toLowerCase()
      )}
      <span aria-hidden="true">·</span>
      <span className="font-mono text-foreground">
        {stats ? `${Math.round(stats.totalNm).toLocaleString()}\u00a0nm` : '—'}
      </span>
    </p>
  )
}

/**
 * The flights tab: a skeleton while loading, a message when there are none, else the sortable
 * table with one row per completed flight.
 *
 * @param props The state of the load, the sorted rows, the sort state, the per-flight lookups, and the handlers.
 * @returns The element.
 */
export function FlightsTable(props: {
  loading: boolean
  flights: LogbookFlight[]
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: SortKey) => void
  registrationFor: (flight: LogbookFlight) => string
  /** The IATA code of the airline of the flight's fleet aircraft, for the logo before the flight number. */
  operatorIataFor: (flight: LogbookFlight) => string | null
  scoreFor: (flightId: number) => number | null
  landingCountFor: (flightId: number) => number
  /** The worst touchdown of the flight: a light shows only for firm or hard. */
  weightUnit: WeightUnit
  onOpen: (flightId: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (props.loading) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            {sortColumns(t).map((col) => (
              <TableHead key={col.key} className={col.className}>
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <LogbookRowsSkeleton />
        </TableBody>
      </Table>
    )
  }
  if (props.flights.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('logbookView.noCompletedFlights')}</p>
  }
  return (
    // v2: a flat list, not a card: quiet column headings, hairlines between taller rows, the figures in the mono face, and a row
    // that lights up under the pointer (winglog-backend docs/plans/v2-design.md, "Logbook list").
    <div className="flex flex-col gap-6 border-t-[3px] border-foreground @3xl:border-t-0 @3xl:[&_tbody_tr]:h-12 [&_tbody_tr:hover]:bg-card [&_th]:text-[13px] [&_th]:font-normal [&_th]:text-muted-foreground [&_thead]:hidden @3xl:[&_thead]:table-header-group @3xl:[&_thead_tr]:border-t-[3px] @3xl:[&_thead_tr]:border-foreground">
      <Table>
        <TableHeader>
          <TableRow>
            {sortColumns(t).map((col) => (
              <SortableHead
                key={col.key}
                sortKey={col.key}
                label={col.label}
                activeKey={props.sortKey}
                dir={props.sortDir}
                onSort={props.onSort}
                className={col.className}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.flights.map((f) => {
            const landingCount = props.landingCountFor(f.id)
            return (
              <TableRow
                key={f.id}
                onClick={() => props.onOpen(f.id)}
                className="cursor-pointer flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-2 py-2.5 after:order-4 after:h-0 after:basis-full after:content-[''] @3xl:table-row @3xl:p-0 @3xl:after:hidden"
              >
                <TableCell className="order-5 p-0 text-[13px] text-muted-foreground @3xl:p-2 @3xl:text-[length:inherit] pl-[30px] font-mono @3xl:pl-2 @3xl:text-sm">
                  {formatDate(f.actualOutUtc)}
                </TableCell>
                <TableCell className="order-1 p-0 @3xl:order-none @3xl:p-2">
                  <span className="inline-flex items-center gap-2.5">
                    <AirlineLogo iata={props.operatorIataFor(f)} size={20} />
                    <span className="font-display font-bold tracking-[-0.01em]">{f.flightNumber ?? '—'}</span>
                    {f.onlineNetwork && (
                      <Badge
                        variant="outline"
                        className="text-xs font-normal"
                        title={f.onlineCallsign ?? undefined}
                      >
                        {f.onlineNetwork === 'ivao' ? 'IVAO' : 'VATSIM'}
                      </Badge>
                    )}
                    {isFreeFlight(f) && (
                      <Badge variant="outline" className="text-xs font-normal">
                        {t('logbookView.freeFlight')}
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="order-2 min-w-0 flex-1 p-0 @3xl:order-none @3xl:p-2">
                  {displayIcao(f.depIcao)} → {displayIcao(f.arrIcao)}
                </TableCell>
                <TableCell className="order-5 p-0 text-[13px] text-muted-foreground @3xl:p-2 @3xl:text-[length:inherit] before:mr-2.5 before:content-['·'] @3xl:before:content-none">
                  {props.registrationFor(f)}
                </TableCell>
                <TableCell className="order-5 p-0 text-[13px] text-muted-foreground @3xl:p-2 @3xl:text-[length:inherit] before:mr-2.5 before:content-['·'] @3xl:before:content-none font-mono @3xl:text-right @3xl:text-sm">
                  {formatMinutes(f.blockMinutes)}
                </TableCell>
                <TableCell className="order-5 p-0 text-[13px] text-muted-foreground @3xl:p-2 @3xl:text-[length:inherit] before:mr-2.5 before:content-['·'] @3xl:before:content-none font-mono @3xl:text-right @3xl:text-sm">
                  {formatWeight(f.fuelBurnKg, props.weightUnit)}
                </TableCell>
                <TableCell className="order-3 p-0 @3xl:order-none @3xl:p-2 @3xl:text-right">
                  <span className="inline-flex items-center gap-1.5">
                    <LandingScoreBadge score={props.scoreFor(f.id)} />
                    {landingCount > 1 && (
                      <Badge variant="outline" className="text-xs">
                        ×{landingCount}
                      </Badge>
                    )}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
