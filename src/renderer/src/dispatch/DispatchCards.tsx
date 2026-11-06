/** The Dispatch tab's cards: "Plan a flight", and the fetched OFP with its aircraft and Fly button (the canvas's r3-dispatch). */

import { useTranslation } from 'react-i18next'
import type { Aircraft, AircraftLastParked, AltitudeUnit, DispatchOfp, WeightUnit } from '@shared/ipc'
import { countSetOptions } from '@shared/dispatch-options'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StatusLight } from '@/components/StatusLight'
import { AirportSearch } from '../AirportSearch'
import { fromDatetimeLocalValue, toDatetimeLocalValue } from '../dispatch-time'
import { formatEnrouteOnly } from '@shared/route'
import { formatAltitude, formatWeight, mToFt } from '../units'
import { asyncHandler } from '../report-error'
import { winglogApi } from '../data/winglog-api'
import { PrefileButtons } from '../online/PrefileButtons'
import type { PlanForm } from './use-dispatch-state'
import { useAirportName } from '../use-airport-name'

/** A panel of the tab: the card colour, a 6 px corner, 20 px inside. */
const PANEL_CLASS = 'rounded-md [--card-spacing:--spacing(5)]'
/** A field's label: quiet and small, above the control. */
const LABEL_CLASS = 'text-[13px] font-normal text-muted-foreground'
/** A code in the mono face. */
const CODE_CLASS = 'font-mono'

function formatTimeZ(iso: string): string {
  return `${iso.slice(11, 16)}Z`
}

function aircraftLabel(a: Aircraft): string {
  return `${a.registration} — ${a.icaoType}${a.operator ? ` (${a.operator})` : ''}`
}

/**
 * "Last parked here at stand N32" — when this aircraft's last flight ended at the airport
 * it's departing from (stand-positions.md). WingLog can't place the aircraft in the sim, so
 * it's a reminder for choosing the starting gate in MSFS.
 *
 * @param props Where the aircraft last parked, and the planned departure.
 * @returns The element, or null when there is nothing to show.
 */
function LastParkedHint(props: {
  parked: AircraftLastParked | undefined
  depIcao: string | null
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!props.parked || !props.depIcao || props.parked.icao !== props.depIcao.toUpperCase()) return null
  return (
    <p className="text-sm text-muted-foreground">
      {t('dispatchView.lastParkedHere', { stand: props.parked.stand })}
    </p>
  )
}

/**
 * An airport field: the code in the mono face with the airport's name quietly under it once it is a known one.
 *
 * @param props The label, the code and its change handler, and the hint under the label that names the departure's last parking.
 * @returns The element.
 */
function AirportField(props: {
  label: string
  value: string
  onChange: (icao: string) => void
  children?: React.ReactNode
}): React.JSX.Element {
  const name = useAirportName(props.value)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label className={LABEL_CLASS}>{props.label}</Label>
      <AirportSearch value={props.value} onChange={props.onChange} inputClassName={CODE_CLASS} />
      {name && <span className="text-[13px] text-muted-foreground">{name}</span>}
      {props.children}
    </div>
  )
}

/**
 * The "Plan a flight" card: aircraft, airports, airline, flight number, departure time, and
 * Generate (or Plan on SimBrief when generation isn't available).
 *
 * @param props The form, the fleet, what's in flight, and the actions.
 * @returns The element.
 */
export function PlanFlightCard(props: {
  form: PlanForm
  aircraft: Aircraft[]
  lastParked: AircraftLastParked[]
  generationAvailable: boolean
  fetching: boolean
  generating: boolean
  onChooseAircraft: (id: number) => void
  onFetch: () => Promise<void>
  onGenerate: () => Promise<void>
  onOpenSimBrief: () => Promise<void>
  onAdvanced: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { form } = props
  const planIncomplete = form.planAircraftId == null || !form.depIcao || !form.destIcao
  const setOptions = countSetOptions(form.dispatchOptions)
  return (
    <Card className={PANEL_CLASS}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-[17px] font-semibold">{t('dispatchView.planAFlight')}</h2>
          <Button
            type="button"
            variant="outline"
            onClick={asyncHandler('DispatchView handleFetch', props.onFetch)}
            disabled={props.fetching || props.generating}
          >
            {props.fetching ? t('dispatchView.fetching') : t('dispatchView.fetchLatestOfp')}
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className={LABEL_CLASS}>{t('dispatchView.aircraft')}</Label>
          <Select
            value={form.planAircraftId != null ? String(form.planAircraftId) : undefined}
            onValueChange={(v) => props.onChooseAircraft(Number(v))}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('dispatchView.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {props.aircraft.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {aircraftLabel(a)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <AirportField label={t('dispatchView.departure')} value={form.depIcao} onChange={form.setDepIcao}>
            <LastParkedHint
              parked={props.lastParked.find((p) => p.aircraftId === form.planAircraftId)}
              depIcao={form.depIcao || null}
            />
          </AirportField>
          <AirportField
            label={t('dispatchView.destination')}
            value={form.destIcao}
            onChange={form.setDestIcao}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <Label className={`${LABEL_CLASS} w-24 flex-col items-start gap-1.5`}>
            {t('dispatchView.airlineIcao')}
            <Input
              type="text"
              className={CODE_CLASS}
              value={form.airlineIcao}
              onChange={(e) => form.setAirlineIcao(e.target.value.toUpperCase())}
              placeholder={t('dispatchView.airlineIcaoPlaceholder')}
            />
          </Label>
          <Label className={`${LABEL_CLASS} w-24 flex-col items-start gap-1.5`}>
            {t('dispatchView.flightNumber')}
            <Input
              type="text"
              className={CODE_CLASS}
              value={form.flightNumber}
              onChange={(e) => form.setFlightNumber(e.target.value)}
              placeholder={t('dispatchView.flightNumberPlaceholder')}
            />
          </Label>
          <Label className={`${LABEL_CLASS} min-w-44 flex-1 flex-col items-start gap-1.5`}>
            {t('dispatchView.departureUtc')}
            <Input
              type="datetime-local"
              className={CODE_CLASS}
              value={form.departureUtc ? toDatetimeLocalValue(form.departureUtc) : ''}
              onChange={(e) => form.setDepartureUtc(fromDatetimeLocalValue(e.target.value))}
            />
          </Label>
        </div>
        <div className="flex gap-2">
          {props.generationAvailable ? (
            <Button
              type="button"
              className="flex-1 font-semibold"
              onClick={asyncHandler('DispatchView handleGenerate', props.onGenerate)}
              disabled={planIncomplete || props.generating}
            >
              {props.generating ? t('dispatchView.generating') : t('dispatchView.generate')}
            </Button>
          ) : (
            // Fallback for a build with no SimBrief API key available at all (e.g.
            // built from source without .env set up) — Dispatch would otherwise have
            // no way to create a plan.
            <Button
              type="button"
              className="flex-1 font-semibold"
              onClick={asyncHandler('DispatchView handleOpenSimBrief', props.onOpenSimBrief)}
              disabled={planIncomplete}
            >
              {t('dispatchView.planOnSimBrief')}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={props.onAdvanced}>
            {setOptions > 0
              ? t('dispatchView.advancedWithCount', { count: setOptions })
              : t('dispatchView.advanced')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * One row of the plan's figures: the name quiet on the left, the figure in the mono face on the right, a hairline under it.
 *
 * @param props The name and the figure.
 * @returns The element.
 */
function FigureRow(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2">
      <dt className="m-0 text-sm text-muted-foreground">{props.label}</dt>
      <dd className="m-0 text-right font-mono text-[15px]">{props.children}</dd>
    </div>
  )
}

/**
 * The step climbs, as one line in the plan's colour: "VHHH 10,400 m · IGNAK 10,100 m".
 *
 * @param props The OFP and the altitude unit.
 * @returns The element.
 */
function StepClimbs(props: { ofp: DispatchOfp; altitudeUnit: AltitudeUnit }): React.JSX.Element {
  const { t } = useTranslation()
  const { ofp, altitudeUnit } = props
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] text-muted-foreground">{t('dispatchView.steps')}</span>
      {ofp.stepClimbs.length === 0 ? (
        <span className="text-sm">{t('dispatchView.none')}</span>
      ) : (
        // Everything on Dispatch is the plan, so only the route and the step climbs are magenta (winglog-backend
        // docs/plans/v2-design.md).
        <p className="m-0 font-mono text-sm leading-relaxed text-plan">
          {ofp.stepClimbs
            .map(
              (climb) => `${climb.atIdent} ${formatAltitude(climb.toAltitudeFt, altitudeUnit, climb.native)}`
            )
            .join(' · ')}
        </p>
      )}
    </div>
  )
}

/**
 * The OFP's figures: aircraft, cruise altitude, times, fuel, payload, weights, cost index, step
 * climbs and route.
 *
 * @param props The OFP and the unit settings.
 * @returns The element.
 */
export function OfpDetails(props: {
  ofp: DispatchOfp
  weightUnit: WeightUnit
  altitudeUnit: AltitudeUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  const { ofp, weightUnit, altitudeUnit } = props
  return (
    <>
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-7">
        <FigureRow label={t('dispatchView.fields.aircraftOfp')}>
          {`${ofp.aircraftIcaoType} · ${ofp.aircraftRegistration}`}
        </FigureRow>
        <FigureRow label={t('dispatchView.fields.cruiseAltitude')}>
          {formatAltitude(mToFt(ofp.cruiseAltM), altitudeUnit)}
        </FigureRow>
        <FigureRow label={t('dispatchView.fields.scheduledOutIn')}>
          {`${formatTimeZ(ofp.schedOutUtc)} / ${formatTimeZ(ofp.schedInUtc)}`}
        </FigureRow>
        <FigureRow label={t('dispatchView.fields.plannedFuel')}>
          {formatWeight(ofp.fuelPlannedKg, weightUnit)}
        </FigureRow>
        <FigureRow label={t('dispatchView.fields.paxCargo')}>
          {`${ofp.pax} / ${formatWeight(ofp.cargoKg, weightUnit)}`}
        </FigureRow>
        <FigureRow label={t('dispatchView.fields.costIndex')}>{ofp.costIndex ?? '—'}</FigureRow>
      </dl>
      <dl className="m-0">
        <FigureRow label={t('dispatchView.fields.zfwTowLdw')}>
          {`${formatWeight(ofp.zfwKg, weightUnit)} / ${formatWeight(ofp.towKg, weightUnit)} / ${formatWeight(ofp.ldwKg, weightUnit)}`}
        </FigureRow>
      </dl>
      <StepClimbs ofp={ofp} altitudeUnit={altitudeUnit} />
      <div className="flex flex-col gap-1">
        <span className="text-[13px] text-muted-foreground">{t('dispatchView.route')}</span>
        <p className="m-0 max-h-16 overflow-auto font-mono text-[13px] leading-relaxed text-plan">
          {formatEnrouteOnly(ofp.ofpJson)}
        </p>
      </div>
    </>
  )
}

/**
 * The fleet aircraft that will fly the OFP, with a light and "Matches the OFP" when it is the one the plan was made for.
 *
 * @param props The OFP, the fleet, the chosen aircraft and its change handler.
 * @returns The element.
 */
function OfpAircraftPicker(props: {
  ofp: DispatchOfp
  aircraft: Aircraft[]
  selectedAircraftId: number | null
  onSelectAircraft: (id: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { ofp, selectedAircraftId } = props
  const chosen = props.aircraft.find((a) => a.id === selectedAircraftId)
  const matches = chosen != null && chosen.registration === ofp.aircraftRegistration
  return (
    <div className="flex min-w-60 flex-[1_1_16rem] flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className={LABEL_CLASS}>{t('dispatchView.fleetAircraft')}</Label>
        {matches && (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <StatusLight state="green" />
            {t('dispatchView.matchesOfp')}
          </span>
        )}
      </div>
      <Select
        value={selectedAircraftId != null ? String(selectedAircraftId) : undefined}
        onValueChange={(v) => props.onSelectAircraft(Number(v))}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={t('dispatchView.selectPlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          {props.aircraft.map((a) => (
            <SelectItem key={a.id} value={String(a.id)}>
              {a.registration} — {a.icaoType}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * Notes under the fleet aircraft: where it last parked, and that none matches the OFP's tail.
 *
 * @param props The OFP, where aircraft last parked, and the chosen aircraft.
 * @returns The element.
 */
function OfpAircraftNotes(props: {
  ofp: DispatchOfp
  lastParked: AircraftLastParked[]
  selectedAircraftId: number | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const { ofp, selectedAircraftId } = props
  return (
    <>
      <LastParkedHint
        parked={props.lastParked.find((p) => p.aircraftId === (selectedAircraftId ?? ofp.matchedAircraftId))}
        depIcao={ofp.depIcao}
      />
      {ofp.matchedAircraftId == null && selectedAircraftId == null && (
        <p className="m-0 text-sm text-muted-foreground">
          {t('dispatchView.noFleetAircraftMatches', {
            tail: ofp.aircraftRegistration || t('dispatchView.noneInOfp')
          })}
        </p>
      )}
    </>
  )
}

/**
 * The fetched OFP: its figures, the offer to save a custom airframe, the fleet aircraft to fly
 * it (until it's flown), and Fly / Discard plan.
 *
 * @param props The OFP, the fleet, the unit settings, the state of the plan, and the actions.
 * @returns The element.
 */
export function OfpCard(props: {
  ofp: DispatchOfp
  aircraft: Aircraft[]
  lastParked: AircraftLastParked[]
  weightUnit: WeightUnit
  altitudeUnit: AltitudeUnit
  /** The plan has already been turned into a flight; shown for reference. */
  alreadyFlown: boolean
  saving: boolean
  airframeCapture: { aircraftId: number; airframeId: string } | null
  selectedAircraftId: number | null
  onSelectAircraft: (id: number) => void
  onViewOfpPdf: () => Promise<void>
  onSaveAirframe: () => Promise<void>
  onFly: () => Promise<void>
  onDiscard: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const { ofp, airframeCapture, alreadyFlown } = props
  return (
    <Card className={PANEL_CLASS}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div>
            <h2 className="m-0 text-xl font-semibold">
              {t('dispatchView.ofpTitle', {
                flightNumber: ofp.flightNumber,
                dep: ofp.depIcao,
                arr: ofp.arrIcao
              })}
            </h2>
            {ofp.altnIcao && (
              <p className="m-0 text-sm text-muted-foreground">
                {t('dispatchView.alternateLabel', { altn: ofp.altnIcao })} ·{' '}
                <span className="text-plan">{t('dispatchView.fromOfp')}</span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {alreadyFlown && <Badge variant="secondary">{t('dispatchView.flying')}</Badge>}
            <PrefileButtons file={(network) => winglogApi().onlinePrefileFromOfp(ofp.ofpJson, network)} />
            <Button
              type="button"
              variant="outline"
              onClick={asyncHandler('DispatchView handleViewOfpPdf', props.onViewOfpPdf)}
            >
              {t('dispatchView.viewOfpPdf')}
            </Button>
          </div>
        </div>
        {airframeCapture && (
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 p-3 text-sm">
            <span className="text-foreground">
              {t('dispatchView.usedCustomAirframeNotSaved', {
                registration: props.aircraft.find((a) => a.id === airframeCapture.aircraftId)?.registration
              })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={asyncHandler('DispatchView handleSaveAirframe', props.onSaveAirframe)}
            >
              {t('dispatchView.saveThisAirframe')}
            </Button>
          </div>
        )}
        <OfpDetails ofp={ofp} weightUnit={props.weightUnit} altitudeUnit={props.altitudeUnit} />
        {!alreadyFlown && (
          <OfpAircraftNotes
            ofp={ofp}
            lastParked={props.lastParked}
            selectedAircraftId={props.selectedAircraftId}
          />
        )}
        <div className="mt-1 flex flex-wrap items-end gap-3">
          {!alreadyFlown && (
            <OfpAircraftPicker
              ofp={ofp}
              aircraft={props.aircraft}
              selectedAircraftId={props.selectedAircraftId}
              onSelectAircraft={props.onSelectAircraft}
            />
          )}
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={asyncHandler('DispatchView handleDiscardPlan', props.onDiscard)}
            >
              {t('dispatchView.discardPlan')}
            </Button>
            <Button
              type="button"
              className="min-w-28 px-5 font-semibold"
              onClick={asyncHandler('DispatchView handleFlyClick', props.onFly)}
              disabled={props.saving || alreadyFlown || props.selectedAircraftId == null}
            >
              {props.saving ? t('dispatchView.starting') : t('dispatchView.fly')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
