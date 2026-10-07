/** The Dispatch tab's cards: "Plan a flight", and the fetched OFP with its aircraft and Fly button. */

import { useTranslation } from 'react-i18next'
import type { Aircraft, AircraftLastParked, AltitudeUnit, DispatchOfp, WeightUnit } from '@shared/ipc'
import { countSetOptions } from '@shared/dispatch-options'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AirportSearch } from '../AirportSearch'
import { fromDatetimeLocalValue, toDatetimeLocalValue } from '../dispatch-time'
import { formatEnrouteOnly } from '../route'
import { formatAltitude, formatWeight, mToFt } from '../units'
import { asyncHandler } from '../report-error'
import type { PlanForm } from './use-dispatch-state'

function formatUtc(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')}Z`
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

function DetailField(props: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="text-foreground">{props.value}</dd>
    </>
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
    <Card>
      <CardHeader>
        <CardTitle>{t('dispatchView.planAFlight')}</CardTitle>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={asyncHandler('DispatchView handleFetch', props.onFetch)}
            disabled={props.fetching || props.generating}
          >
            {props.fetching ? t('dispatchView.fetching') : t('dispatchView.fetchLatestOfp')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>{t('dispatchView.aircraft')}</Label>
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
        <div className="flex flex-col gap-1.5">
          <Label>{t('dispatchView.departure')}</Label>
          <AirportSearch value={form.depIcao} onChange={form.setDepIcao} />
          <LastParkedHint
            parked={props.lastParked.find((p) => p.aircraftId === form.planAircraftId)}
            depIcao={form.depIcao || null}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('dispatchView.destination')}</Label>
          <AirportSearch value={form.destIcao} onChange={form.setDestIcao} />
        </div>
        <div className="flex gap-3">
          <Label className="flex flex-1 flex-col items-start gap-1.5">
            {t('dispatchView.airlineIcao')}
            <Input
              type="text"
              value={form.airlineIcao}
              onChange={(e) => form.setAirlineIcao(e.target.value.toUpperCase())}
              placeholder={t('dispatchView.airlineIcaoPlaceholder')}
            />
          </Label>
          <Label className="flex flex-1 flex-col items-start gap-1.5">
            {t('dispatchView.flightNumber')}
            <Input
              type="text"
              value={form.flightNumber}
              onChange={(e) => form.setFlightNumber(e.target.value)}
              placeholder={t('dispatchView.flightNumberPlaceholder')}
            />
          </Label>
        </div>
        <Label className="flex flex-col items-start gap-1.5">
          {t('dispatchView.departureUtc')}
          <Input
            type="datetime-local"
            value={form.departureUtc ? toDatetimeLocalValue(form.departureUtc) : ''}
            onChange={(e) => form.setDepartureUtc(fromDatetimeLocalValue(e.target.value))}
          />
        </Label>
        <div className="flex gap-2">
          {props.generationAvailable ? (
            <Button
              type="button"
              className="flex-1"
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
              className="flex-1"
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
 * The OFP's figures: aircraft, cruise altitude, times, fuel, payload, weights, cost index, step
 * climbs and route.
 *
 * @param props The OFP and the unit settings.
 * @returns The element.
 */
function OfpDetails(props: {
  ofp: DispatchOfp
  weightUnit: WeightUnit
  altitudeUnit: AltitudeUnit
}): React.JSX.Element {
  const { t } = useTranslation()
  const { ofp, weightUnit, altitudeUnit } = props
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        <DetailField
          label={t('dispatchView.fields.aircraftOfp')}
          value={`${ofp.aircraftIcaoType} ${ofp.aircraftRegistration}`}
        />
        <DetailField
          label={t('dispatchView.fields.cruiseAltitude')}
          value={formatAltitude(mToFt(ofp.cruiseAltM), altitudeUnit)}
        />
        <DetailField
          label={t('dispatchView.fields.scheduledOutIn')}
          value={`${formatUtc(ofp.schedOutUtc)} / ${formatUtc(ofp.schedInUtc)}`}
        />
        <DetailField
          label={t('dispatchView.fields.plannedFuel')}
          value={formatWeight(ofp.fuelPlannedKg, weightUnit)}
        />
        <DetailField
          label={t('dispatchView.fields.paxCargo')}
          value={`${ofp.pax} / ${formatWeight(ofp.cargoKg, weightUnit)}`}
        />
        <DetailField
          label={t('dispatchView.fields.zfwTowLdw')}
          value={`${formatWeight(ofp.zfwKg, weightUnit)} / ${formatWeight(ofp.towKg, weightUnit)} / ${formatWeight(ofp.ldwKg, weightUnit)}`}
        />
        <DetailField label={t('dispatchView.fields.costIndex')} value={ofp.costIndex ?? '—'} />
      </dl>
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="text-muted-foreground">{t('dispatchView.steps')}</span>
        {ofp.stepClimbs.length === 0 ? (
          <span className="text-foreground">{t('dispatchView.none')}</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {ofp.stepClimbs.map((climb) => (
              <Badge key={climb.atIdent} variant="outline" className="gap-1.5 font-normal">
                <span className="text-muted-foreground">{climb.atIdent}</span>
                <span className="font-mono tabular-nums text-foreground">
                  {formatAltitude(climb.toAltitudeFt, altitudeUnit, climb.native)}
                </span>
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="text-muted-foreground">{t('dispatchView.route')}</span>
        <p className="max-h-16 overflow-auto text-foreground">{formatEnrouteOnly(ofp.ofpJson)}</p>
      </div>
    </>
  )
}

/**
 * The fleet aircraft that will fly the OFP, with the last-parked hint and a note when no fleet
 * aircraft matches the OFP's registration.
 *
 * @param props The OFP, the fleet, the chosen aircraft and its change handler.
 * @returns The element.
 */
function OfpAircraftPicker(props: {
  ofp: DispatchOfp
  aircraft: Aircraft[]
  lastParked: AircraftLastParked[]
  selectedAircraftId: number | null
  onSelectAircraft: (id: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { ofp, selectedAircraftId } = props
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label>{t('dispatchView.fleetAircraft')}</Label>
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
                {a.registration === ofp.aircraftRegistration ? ` ${t('dispatchView.matched')}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <LastParkedHint
        parked={props.lastParked.find((p) => p.aircraftId === (selectedAircraftId ?? ofp.matchedAircraftId))}
        depIcao={ofp.depIcao}
      />
      {ofp.matchedAircraftId == null && selectedAircraftId == null && (
        <p className="text-sm text-muted-foreground">
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
    <Card>
      <CardHeader>
        <CardTitle>
          {t('dispatchView.ofpTitle', {
            flightNumber: ofp.flightNumber,
            dep: ofp.depIcao,
            arr: ofp.arrIcao,
            altn: ofp.altnIcao
          })}
        </CardTitle>
        <CardAction className="flex items-center gap-2">
          {alreadyFlown && <Badge variant="secondary">{t('dispatchView.flying')}</Badge>}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={asyncHandler('DispatchView handleViewOfpPdf', props.onViewOfpPdf)}
          >
            {t('dispatchView.viewOfpPdf')}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {airframeCapture && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 p-3 text-sm">
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
          <OfpAircraftPicker
            ofp={ofp}
            aircraft={props.aircraft}
            lastParked={props.lastParked}
            selectedAircraftId={props.selectedAircraftId}
            onSelectAircraft={props.onSelectAircraft}
          />
        )}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="lg"
            className="flex-[2]"
            onClick={asyncHandler('DispatchView handleFlyClick', props.onFly)}
            disabled={props.saving || alreadyFlown || props.selectedAircraftId == null}
          >
            {props.saving ? t('dispatchView.starting') : t('dispatchView.fly')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={asyncHandler('DispatchView handleDiscardPlan', props.onDiscard)}
          >
            {t('dispatchView.discardPlan')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
