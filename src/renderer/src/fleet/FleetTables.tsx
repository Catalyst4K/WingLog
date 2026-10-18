/** The Fleet tab's two lists: active aircraft (sortable) and retired or replaced ones. */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { Aircraft, AircraftLastParked, FleetStats } from '@shared/ipc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SortableHead } from '../SortableHead'
import { AirlineLabel } from './DetailCards'
import { formatDate, useLocationLabel } from './fleet-format'

export type FleetSortKey = 'registration' | 'type' | 'airline' | 'location' | 'hours' | 'flights'

function fleetSortColumns(t: TFunction): { key: FleetSortKey; label: string }[] {
  return [
    { key: 'registration', label: t('fleetView.sortColumns.registration') },
    { key: 'type', label: t('fleetView.sortColumns.type') },
    { key: 'airline', label: t('fleetView.sortColumns.airline') },
    { key: 'location', label: t('fleetView.sortColumns.location') },
    { key: 'hours', label: t('fleetView.sortColumns.hours') },
    { key: 'flights', label: t('fleetView.sortColumns.flights') }
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
  const locationLabel = useLocationLabel()
  return (
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
            />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.rows.map((a) => {
          const s = props.stats.find((x) => x.aircraftId === a.id)
          const icao = a.currentIcao ?? s?.lastArrIcao ?? null
          return (
            <TableRow key={a.id} onClick={() => props.onOpen(a.id)} className="cursor-pointer">
              <TableCell className="font-medium">{a.registration}</TableCell>
              <TableCell>{a.icaoType}</TableCell>
              <TableCell>
                <AirlineLabel operator={a.operator} operatorIata={a.operatorIata} />
              </TableCell>
              <TableCell>
                {locationLabel(
                  icao,
                  props.lastParked.find((p) => p.aircraftId === a.id)
                )}
              </TableCell>
              <TableCell>{s ? s.totalHours.toFixed(1) : '0.0'}</TableCell>
              <TableCell>{s?.totalCycles ?? 0}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
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
