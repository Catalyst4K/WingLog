/** The Logbook's landings tab: every touchdown across the fleet. */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LandingListRow } from '@shared/ipc'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { displayIcao } from '../display-icao'
import { useSortable } from '../hooks/useSortable'
import { LandingScoreBadge } from '../LandingScoreBadge'
import { SortableHead } from '../SortableHead'
import { msToFpm } from '../units'
import { runAsync } from '../report-error'
import { formatDate } from './logbook-format'
import { LANDING_SORT_KEYS, landingSortColumns, compareLandingRows, type LandingSortKey } from './sorting'

export function LogbookRowsSkeleton(): React.JSX.Element {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <TableRow key={i}>
          {[0, 1, 2, 3, 4, 5, 6].map((col) => (
            <TableCell key={col}>
              <Skeleton className="h-4 w-16" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

/**
 * The Logbook Landings sub-tab (winglog-backend's docs/plans/multiple-landings.md
 * Phase 3) — every touchdown across the whole fleet, one row per landing rather than one
 * row per flight. Exported for direct testing, same reasoning as LandingCard above.
 *
 * @param props The handler that opens a flight, and the landings (fetched when not given).
 * @returns The element.
 */
export function LandingsTable(props: {
  onOpenFlight: (flightId: number) => void
  /** Already-fetched rows (LogbookView loads them with the flights, so switching to this tab
   *  is instant with no skeleton). Omit to have the table fetch its own. */
  landings?: LandingListRow[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const [ownLandings, setOwnLandings] = useState<LandingListRow[] | undefined>(undefined)

  useEffect(() => {
    if (props.landings !== undefined) return
    runAsync(
      'LogbookView logbookListAllLandings',
      window.winglog.logbookListAllLandings().then(setOwnLandings)
    )
  }, [props.landings])
  const landings = props.landings ?? ownLandings

  const comparators = Object.fromEntries(
    LANDING_SORT_KEYS.map((key) => [
      key,
      (a: LandingListRow, b: LandingListRow) => compareLandingRows(a, b, key)
    ])
  ) as Record<LandingSortKey, (a: LandingListRow, b: LandingListRow) => number>
  const {
    sortKey,
    sortDir,
    sortedRows: sortedLandings,
    handleSort
  } = useSortable<LandingListRow, LandingSortKey>(landings ?? [], comparators, 'date', 'desc')

  if (landings === undefined) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            {landingSortColumns(t).map((col) => (
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

  if (landings.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('logbookView.landingsEmpty')}</p>
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {landingSortColumns(t).map((col) => (
            <SortableHead
              key={col.key}
              sortKey={col.key}
              label={col.label}
              activeKey={sortKey}
              dir={sortDir}
              onSort={handleSort}
              className={col.className}
            />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedLandings.map((l) => (
          <TableRow key={l.id} onClick={() => props.onOpenFlight(l.flightId)} className="cursor-pointer">
            <TableCell>{formatDate(l.touchdownTsUtc)}</TableCell>
            <TableCell>{l.flightNumber ?? '—'}</TableCell>
            <TableCell>
              {l.icao ? displayIcao(l.icao) : '—'}
              {l.runwayIdent ? ` / ${l.runwayIdent}` : ''}
            </TableCell>
            <TableCell>{l.aircraftRegistration}</TableCell>
            <TableCell>{Math.round(msToFpm(l.verticalSpeedMs))} fpm</TableCell>
            <TableCell>{l.gForce.toFixed(2)}</TableCell>
            <TableCell className="text-center">
              <LandingScoreBadge score={l.score} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
