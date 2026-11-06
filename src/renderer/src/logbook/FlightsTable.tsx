/** The Logbook's flights tab and the totals above it. */

import { useTranslation } from 'react-i18next'
import type { LogbookFlight, LogbookStats, WeightUnit } from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
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
    <p className="m-0 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
      {stat(stats?.totalFlights ?? props.flightCount, t('logbookView.stats.totalFlights'))}
      {stat(formatMinutes(stats?.totalBlockMinutes ?? null), t('logbookView.stats.totalFlightHours'))}
      {stat(
        stats ? `${Math.round(stats.totalNm).toLocaleString()} nm` : '—',
        t('logbookView.stats.totalMilesFlown')
      )}
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
    <div className="flex flex-col gap-6 [&_tbody_tr]:h-11 [&_tbody_tr:hover]:bg-card [&_th]:text-xs [&_th]:font-normal [&_th]:text-muted-foreground">
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
              <TableRow key={f.id} onClick={() => props.onOpen(f.id)} className="cursor-pointer">
                <TableCell className="font-mono text-sm">{formatDate(f.actualOutUtc)}</TableCell>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5">
                    {f.flightNumber ?? '—'}
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
                <TableCell>
                  {displayIcao(f.depIcao)} → {displayIcao(f.arrIcao)}
                </TableCell>
                <TableCell>{props.registrationFor(f)}</TableCell>
                <TableCell className="font-mono text-sm">{formatMinutes(f.blockMinutes)}</TableCell>
                <TableCell className="font-mono text-sm">
                  {formatWeight(f.fuelBurnKg, props.weightUnit)}
                </TableCell>
                <TableCell className="text-center">
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
