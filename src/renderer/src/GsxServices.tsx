/** The GSX page's services: each with its light, what it has done, who provides it and what it cost (the canvas's r3-gsx). */

import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import type { GsxRemoteServiceStatus } from '@shared/ipc'
import { SectionHeading } from '@/components/SectionHeading'
import { StatusLight, type LightState } from '@/components/StatusLight'
import {
  formatCargoProgress,
  formatFuelProgress,
  formatGsxBill,
  formatPaxProgress,
  hiddenServices,
  serviceLight,
  visibleServices
} from './gsx-remote-format'

/**
 * Structured `detail` fields (fuel current/target, pax/cargo counts) render as formatted numbers instead of `statusText`'s free
 * text (docs/gsx-notes.md, rounds 6/7), falling back to `statusText`/`stateText` for every other service. `detail.waitingFor`
 * (a vehicle-pathing stall, round 11) renders alongside whichever branch is active rather than replacing it: GSX keeps
 * reporting real pax/cargo counts while stuck, and the counts alone don't explain why they stopped moving.
 *
 * @param props The service.
 * @returns The element, or null when there is nothing to show.
 */
/**
 * A progress line, "15,357 / 81,488 kg": what is done, then the target the plan asked for in the mono face. Plan text is never coloured,
 * and the target needs no "(OFP)": a figure after a slash is plainly the target.
 *
 * @param props The line as the format functions write it.
 * @returns The element.
 */
function ProgressText(props: { text: string }): React.JSX.Element {
  const at = props.text.indexOf(' / ')
  if (at < 0) return <span>{props.text}</span>
  return (
    <span>
      {props.text.slice(0, at)} /{' '}
      <span className="font-mono text-foreground">{props.text.slice(at + 3)}</span>
    </span>
  )
}

function ServiceProgress(props: { service: GsxRemoteServiceStatus }): React.JSX.Element | null {
  const { t } = useTranslation()
  const detail = props.service.detail
  const waitingFor = detail?.waitingFor
  const waitingLine =
    waitingFor && waitingFor.length > 0 ? (
      <span className="text-amber-600 dark:text-amber-500">
        {t('gsxRemotePanel.waitingFor', { reason: waitingFor.join('; ') })}
      </span>
    ) : null

  if (detail?.fuel) {
    return (
      <span className="flex flex-col text-muted-foreground">
        {waitingLine}
        <ProgressText text={formatFuelProgress(detail.fuel)} />
      </span>
    )
  }
  if (detail?.pax) {
    return (
      <span className="flex flex-col text-muted-foreground">
        {waitingLine}
        <ProgressText text={formatPaxProgress(detail.pax)} />
        {detail.cargo?.map((cargo) => (
          <ProgressText key={cargo.hold} text={formatCargoProgress(cargo)} />
        ))}
      </span>
    )
  }
  const fallback = props.service.statusText || props.service.stateText
  if (!fallback && !waitingLine) return null
  return (
    <span className="flex flex-col text-muted-foreground">
      {waitingLine}
      {fallback && <span className="whitespace-pre-line">{fallback}</span>}
    </span>
  )
}

/**
 * A service's light as the canvas draws it (r3-gsx): filled green when done, a green ring while it is under way, off while it is still to come.
 *
 * @param props The light's state (amber is "under way").
 * @returns The element.
 */
function ServiceLight(props: { state: LightState }): React.JSX.Element {
  const common = 'size-2.5 shrink-0 rounded-full'
  if (props.state === 'amber') {
    return (
      <span
        aria-hidden="true"
        data-slot="status-light"
        data-state="amber"
        className={`${common} box-border border-2 border-light-green`}
      />
    )
  }
  return <StatusLight state={props.state} className={common} />
}

/**
 * How far a fuel service has got, for the thin bar under its row.
 *
 * @param service The service.
 * @returns A share from 0 to 100, or null when it is not a fuel service with a target.
 */
function fuelShare(service: GsxRemoteServiceStatus): number | null {
  const fuel = service.detail?.fuel
  if (!fuel || fuel.target <= 0) return null
  return Math.max(0, Math.min(100, (fuel.current / fuel.target) * 100))
}

function ServiceRow(props: { service: GsxRemoteServiceStatus }): React.JSX.Element {
  const { t } = useTranslation()
  const bill = props.service.detail?.bill
  const light = serviceLight(props.service)
  const share = light === 'amber' ? fuelShare(props.service) : null
  const stateKey = light === 'green' ? 'stateDone' : light === 'amber' ? 'stateInProgress' : 'stateNotStarted'
  return (
    <li className="grid min-h-[60px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-2 text-sm">
      <ServiceLight state={light} />
      <div className="min-w-0">
        <div className="font-medium text-foreground">
          {props.service.displayName}
          <span className="ml-1.5 font-normal text-muted-foreground">{t(`gsxRemotePanel.${stateKey}`)}</span>
        </div>
        <div className="text-sm text-muted-foreground">
          <ServiceProgress service={props.service} />
        </div>
        {share !== null && (
          <div className="mt-1.5 h-[3px] max-w-[360px] rounded-sm bg-border" aria-hidden="true">
            <div className="h-[3px] rounded-sm bg-foreground" style={{ width: `${share}%` }} />
          </div>
        )}
      </div>
      <div className="text-right text-sm text-muted-foreground">
        {props.service.operator && (
          <div>{t('gsxRemotePanel.provider', { name: props.service.operator })}</div>
        )}
        {typeof bill === 'number' && <div className="font-mono text-foreground">{formatGsxBill(bill)}</div>}
      </div>
    </li>
  )
}

/**
 * The GSX services, with the ones that matter now shown and the rest collapsed, opened by the section's rule. The GSX menu comes under
 * the heading, or above the whole section from the page's wrap width up (the page's `@container`).
 *
 * @param props The services, and the GSX menu.
 * @returns The list with the menu, or just the menu when there are no services.
 */
export function ServicesList(props: {
  services: GsxRemoteServiceStatus[]
  menu: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  if (props.services.length === 0) return <>{props.menu}</>
  const visible = visibleServices(props.services)
  const hidden = hiddenServices(props.services)
  return (
    <section className="flex flex-col" aria-label={t('gsxRemotePanel.services')}>
      <SectionHeading
        className="order-1 @3xl:order-2"
        level={3}
        title={t('gsxRemotePanel.services')}
        aside={t('gsxRemotePanel.servicesLegend')}
      />
      <div className="order-2 pt-1 pb-3 @3xl:order-1 @3xl:pb-6">{props.menu}</div>
      <ul className="order-3 m-0 flex list-none flex-col p-0">
        {visible.map((service) => (
          <ServiceRow key={service.id} service={service} />
        ))}
      </ul>
      {hidden.length > 0 && (
        <details className="group order-4">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground">
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            />
            {t('gsxRemotePanel.showMoreServices', { count: hidden.length })}
          </summary>
          <ul className="m-0 mt-1.5 flex list-none flex-col p-0">
            {hidden.map((service) => (
              <ServiceRow key={service.id} service={service} />
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
