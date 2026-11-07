/** The Fleet tab's two lists: active aircraft (sortable) and retired or replaced ones. */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Aircraft, AircraftLastParked, FleetStats } from '@shared/ipc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SortableHead } from '../SortableHead'
import { AirlineLabel } from './DetailCards'
import { airportAndStand, formatDate } from './fleet-format'

export type FleetSortKey = 'registration' | 'type' | 'airline' | 'location' | 'stand' | 'hours' | 'flights'

function fleetSortColumns(t: TFunction): { key: FleetSortKey; label: string; className?: string }[] {
  return [
    { key: 'registration', label: t('fleetView.sortColumns.registration'), className: 'w-[120px]' },
    { key: 'type', label: t('fleetView.sortColumns.type'), className: 'w-[90px]' },
    { key: 'airline', label: t('fleetView.sortColumns.airline') },
    { key: 'location', label: t('fleetView.sortColumns.location'), className: 'w-[220px]' },
    { key: 'stand', label: t('fleetView.sortColumns.stand'), className: 'w-[110px]' },
    { key: 'hours', label: t('fleetView.sortColumns.hours'), className: 'w-[90px] text-right' },
    { key: 'flights', label: t('fleetView.sortColumns.flights'), className: 'w-[80px] text-right' }
  ]
}

/**
 * The active aircraft, one row each, with sortable columns.
 *
 * @param props The rows already sorted, their stats and stands, the sort state, and the handlers.
 * @returns The element.
 */
export function ActiveFleetTable(props: {
  rows: Aircraft[]
  stats: FleetStats[]
  lastParked: AircraftLastParked[]
  sortKey: FleetSortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: FleetSortKey) => void
  onOpen: (id: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    // As on the design canvas (r3-fleet-list): quiet headings, taller rows divided by hairlines with a hover, the figures in the mono face.
    <div className="border-t-[3px] border-foreground @3xl:border-t-0 @3xl:[&_tbody_tr]:h-[52px] [&_tbody_tr:hover]:bg-card [&_th]:text-[13px] [&_th]:font-normal [&_th]:text-muted-foreground [&_thead]:hidden @3xl:[&_thead]:table-header-group @3xl:[&_thead_tr]:border-t-[3px] @3xl:[&_thead_tr]:border-foreground">
      <Table>
        <TableHeader>
          <TableRow>
            {fleetSortColumns(t).map((col) => (
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
          {props.rows.map((a) => {
            const s = props.stats.find((x) => x.aircraftId === a.id)
            const icao = a.currentIcao ?? s?.lastArrIcao ?? null
            const where = airportAndStand(
              icao,
              props.lastParked.find((p) => p.aircraftId === a.id)
            )
            return (
              <TableRow
                key={a.id}
                onClick={() => props.onOpen(a.id)}
                className="cursor-pointer flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-2 py-2.5 after:order-4 after:h-0 after:basis-full after:content-[''] @3xl:table-row @3xl:p-0 @3xl:after:hidden"
              >
                <TableCell className="order-1 p-0 font-display font-bold tracking-[-0.01em] @3xl:order-none @3xl:p-2">
                  {a.registration}
                </TableCell>
                <TableCell className="order-2 p-0 font-mono text-sm @3xl:order-none @3xl:p-2">
                  {a.icaoType}
                </TableCell>
                <TableCell className="order-3 ml-auto p-0 @3xl:order-none @3xl:ml-0 @3xl:p-2">
                  <AirlineLabel operator={a.operator} operatorIata={a.operatorIata} size={20} />
                </TableCell>
                <TableCell className="order-5 p-0 text-[13px] text-muted-foreground @3xl:p-2 @3xl:text-[length:inherit] font-mono @3xl:text-[length:inherit] @3xl:text-foreground">
                  {where.airport ?? '—'}
                </TableCell>
                <TableCell className="order-5 p-0 text-[13px] text-muted-foreground @3xl:p-2 @3xl:text-[length:inherit] before:mr-2.5 before:content-['·'] @3xl:before:content-none font-mono @3xl:text-[length:inherit]">
                  {where.stand ?? ''}
                </TableCell>
                <TableCell className="order-5 p-0 text-[13px] text-muted-foreground @3xl:p-2 @3xl:text-[length:inherit] before:mr-2.5 before:content-['·'] @3xl:before:content-none font-mono @3xl:text-[length:inherit] @3xl:text-right @3xl:text-foreground">
                  {s ? s.totalHours.toFixed(1) : '0.0'}
                </TableCell>
                <TableCell className="order-5 p-0 text-[13px] text-muted-foreground @3xl:p-2 @3xl:text-[length:inherit] before:mr-2.5 before:content-['·'] @3xl:before:content-none font-mono @3xl:text-[length:inherit] @3xl:text-right @3xl:text-foreground">
                  {s?.totalCycles ?? 0}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <p className="m-0 border-t border-border px-3 pt-3.5 text-[13px] text-muted-foreground">
        {t('fleetView.standNote')}
      </p>
    </div>
  )
}

/**
 * What the Status cell says for a retired aircraft: "retired on …", or a link to the aircraft
 * that replaced it (plain text when that aircraft is no longer in the fleet).
 *
 * @param props The retired aircraft, the whole fleet to find its replacement in, and the handler.
 * @returns The element.
 */
function RetiredStatus(props: {
  aircraft: Aircraft
  fleet: Aircraft[]
  onOpen: (id: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const a = props.aircraft
  if (a.replacedByAircraftId === null) {
    return (
      <>
        {t('fleetView.retiredStatus', {
          date: a.retiredAt ? t('fleetView.detail.retiredOn', { date: formatDate(a.retiredAt) }) : ''
        })}
      </>
    )
  }
  const replacement = props.fleet.find((c) => c.id === a.replacedByAircraftId)
  if (!replacement) return <>{t('fleetView.replacedByUnknown', { id: a.replacedByAircraftId })}</>
  return (
    <button
      type="button"
      className="cursor-pointer text-foreground underline underline-offset-2"
      onClick={(e) => {
        e.stopPropagation()
        props.onOpen(replacement.id)
      }}
    >
      {t('fleetView.replacedBy', { registration: replacement.registration })}
    </button>
  )
}

/**
 * The retired and replaced aircraft.
 *
 * @param props The retired aircraft, the whole fleet, and the handler that opens an aircraft.
 * @returns The element.
 */
export function RetiredFleetTable(props: {
  rows: Aircraft[]
  fleet: Aircraft[]
  onOpen: (id: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('fleetView.retiredTable.registration')}</TableHead>
            <TableHead>{t('fleetView.retiredTable.type')}</TableHead>
            <TableHead>{t('fleetView.retiredTable.status')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((a) => (
            <TableRow
              key={a.id}
              onClick={() => props.onOpen(a.id)}
              className="cursor-pointer text-muted-foreground"
            >
              <TableCell className="font-medium">{a.registration}</TableCell>
              <TableCell>{a.icaoType}</TableCell>
              <TableCell>
                <RetiredStatus aircraft={a} fleet={props.fleet} onOpen={props.onOpen} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
