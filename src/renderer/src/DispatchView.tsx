import { isRetired } from '@shared/aircraft'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type {
  Aircraft,
  AltitudeUnit,
  DispatchOfp,
  FleetStats,
  Flight,
  ProcedureSelection,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AirportSearch } from './AirportSearch'
import { DispatchAdvancedDialog } from './DispatchAdvancedDialog'
import { countSetOptions, defaultDispatchOptions, dispatchOptionsToUrlParams, type DispatchOptions } from '@shared/dispatch-options'
import { defaultDepartureTime, fromDatetimeLocalValue, toDatetimeLocalValue, toSimBriefDeparture } from './dispatch-time'
import { lastKnownFuelOnBoard } from './fleet-fuel'
import { useConfirm } from './hooks/useConfirm'
import { MetarPanel } from './MetarPanel'
import { ProcedureSelector } from './ProcedureSelector'
import { flightLabel } from './flight-label'
import { useLiveWaypoints } from './procedureSelection'
import { formatEnrouteOnly } from './route'
import { formatAltitude, formatWeight, mToFt } from './units'

function formatUtc(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')}Z`
}

function aircraftLabel(a: Aircraft): string {
  return `${a.registration} — ${a.icaoType}${a.operator ? ` (${a.operator})` : ''}`
}

function DetailField(props: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="text-foreground">{props.value}</dd>
    </>
  )
}

export function DispatchView(props: {
  weightUnit: WeightUnit
  altitudeUnit: AltitudeUnit
  windSpeedUnit: WindSpeedUnit
  /** Called after a planned flight is saved, so the app can switch to Track to preview it. */
  onPlanned?: () => void
  /** The currently fetched/created OFP — lifted to App so it survives switching away to
   *  another tab and back, and so Track can preview it before it's saved as a flight. */
  ofp: DispatchOfp | null
  onOfpChange: (ofp: DispatchOfp | null) => void
  /** ofpId of the OFP that's already been turned into a flight, if any — also lifted, so
   *  "still planning this" vs. "already flying this, shown for reference" survives a
   *  tab switch the same way `ofp` does. */
  dispatchedOfpId: string | null
  onDispatchedOfpIdChange: (ofpId: string | null) => void
  /** The live procedure selection — lifted to App.tsx so Dispatch and Track always agree on
   *  what's currently chosen (docs/plans/navdata-without-navigraph.md, Phase 5). */
  selection: ProcedureSelection
  onSelectionChange: (next: ProcedureSelection) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { ofp } = props
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [fleetStats, setFleetStats] = useState<FleetStats[]>([])
  const [pastFlights, setPastFlights] = useState<Flight[]>([])
  const [dispatchOptions, setDispatchOptions] = useState<DispatchOptions>(defaultDispatchOptions())
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selectedAircraftId, setSelectedAircraftId] = useState<number | null>(null)
  const [planAircraftId, setPlanAircraftId] = useState<number | null>(null)
  // The selected aircraft's own completed flights, for "fuel on board after last flight"
  // (flightdeck-backend's docs/plans/fleet-maintenance.md, Part 2) — a separate fetch from
  // pastFlights below, which is every flight regardless of aircraft, for a different purpose
  // (the advanced dialog's "load settings from a previous flight").
  const [selectedAircraftFlights, setSelectedAircraftFlights] = useState<Flight[]>([])
  const [depIcao, setDepIcao] = useState('')
  const [destIcao, setDestIcao] = useState('')
  // Airline ICAO prefills from the selected aircraft's operatorIcao but stays editable —
  // an aircraft with a free-typed operator (no code resolved) leaves this blank rather
  // than blocking the flight-number field entirely.
  const [airlineIcao, setAirlineIcao] = useState('')
  const [flightNumber, setFlightNumber] = useState('')
  // Defaulted once, on aircraft selection, per dispatch-time.ts's own doc comment — not
  // re-derived on every render, or the value would silently drift under the user while
  // they fill in the rest of the form.
  const [departureUtc, setDepartureUtc] = useState<Date | null>(null)
  const [fetching, setFetching] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generationAvailable, setGenerationAvailable] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirm, confirmDialog] = useConfirm()
  // Set after a fetch whose OFP was generated against a custom airframe that differs from
  // (or is missing on) the matched fleet aircraft — offered, not applied silently, same
  // as the registration-match heuristic (docs/decisions.md, fleet-simbrief-airframe entry).
  const [airframeCapture, setAirframeCapture] = useState<{ aircraftId: number; airframeId: string } | null>(null)
  // The live route with the current selection spliced in — single source of truth this and
  // Track's map both render from (docs/plans/navdata-without-navigraph.md, Phase 5).
  const liveWaypoints = useLiveWaypoints(ofp, props.selection)

  useEffect(() => {
    // Retired aircraft (replacedByAircraftId set — docs/plans/aircraft-replacement.md) have
    // no flights of their own left and shouldn't be offered anywhere an aircraft is picked.
    window.winglog.aircraftList().then((list) => setAircraft(list.filter((a) => !isRetired(a))))
    window.winglog.logbookFleetStats().then(setFleetStats)
    window.winglog.dispatchGenerationAvailable().then(setGenerationAvailable)
    // Source list for the advanced dialog's "Load settings from a previous flight" —
    // flightList already returns newest-first (docs/decisions.md).
    window.winglog.flightList().then(setPastFlights)
  }, [])

  useEffect(() => {
    if (selectedAircraftId == null) return
    window.winglog.fleetListFlights(selectedAircraftId).then(setSelectedAircraftFlights)
  }, [selectedAircraftId])

  // Guarded on selectedAircraftId rather than clearing selectedAircraftFlights when it goes
  // null (e.g. "Discard plan") — that would mean calling setState synchronously in the effect
  // above just to reset it, when checking here achieves the same thing during render instead.
  const fuelOnBoardFlight = selectedAircraftId != null ? lastKnownFuelOnBoard(selectedAircraftFlights) : null
  // "top up to the plan" — Callum's own practical use case for this. A convenience number
  // only, never sent to the sim; clamped to 0 rather than shown negative when the aircraft
  // already has more on board than planned.
  const upliftNeededKg =
    fuelOnBoardFlight?.fuelInKg != null && ofp?.fuelPlannedKg != null
      ? Math.max(0, ofp.fuelPlannedKg - fuelOnBoardFlight.fuelInKg)
      : null

  function handlePlanAircraftChange(id: number): void {
    setPlanAircraftId(id)
    const selected = aircraft.find((a) => a.id === id)
    // Same fallback as the Fleet detail page's "Current airport": stored currentIcao
    // first, then the last completed flight's arrival airport — most of an imported
    // fleet has no currentIcao set (CSV import deliberately doesn't backfill it) but
    // does have real flight history to derive a location from.
    const lastArrIcao = fleetStats.find((s) => s.aircraftId === id)?.lastArrIcao
    setDepIcao(selected?.currentIcao ?? lastArrIcao ?? '')
    setAirlineIcao(selected?.operatorIcao ?? '')
    setDepartureUtc(defaultDepartureTime(new Date()))
    setSelectedAircraftId(id)
  }

  async function handleOpenSimBrief(): Promise<void> {
    const selected = aircraft.find((a) => a.id === planAircraftId)
    if (!selected || !depIcao || !destIcao) return
    await window.winglog.dispatchOpenSimBrief({
      origIcao: depIcao,
      destIcao,
      icaoType: selected.icaoType,
      simbriefAirframeId: selected.simbriefAirframeId,
      simbriefType: selected.simbriefType,
      airlineIcao: airlineIcao || null,
      flightNumber: flightNumber || null,
      departure: departureUtc ? toSimBriefDeparture(departureUtc) : null,
      extra: dispatchOptionsToUrlParams(dispatchOptions)
    })
  }

  // Shared by handleFetch and handleGenerate — both end up with a DispatchOfp and need
  // to run the same matched-aircraft / airframe-capture logic on it.
  function applyFetchedOfp(fetched: DispatchOfp): void {
    props.onOfpChange(fetched)
    // A flight already chosen in the "Plan a flight" panel above takes priority over the
    // registration-match heuristic — that heuristic stays as a fallback for anyone who
    // fetches without going through that panel first.
    const aircraftId = selectedAircraftId ?? fetched.matchedAircraftId
    setSelectedAircraftId(aircraftId)

    const matched = aircraftId != null ? aircraft.find((a) => a.id === aircraftId) : undefined
    if (matched) {
      if (fetched.simbriefIsCustom && fetched.simbriefInternalId) {
        // simbriefInternalId is only a real airframe ID (not a bare type code) when
        // simbriefIsCustom is true — see the field's doc comment in simbrief-client.ts.
        if (matched.simbriefAirframeId !== fetched.simbriefInternalId) {
          setAirframeCapture({ aircraftId: matched.id, airframeId: fetched.simbriefInternalId })
        }
      } else if (matched.simbriefAirframeId) {
        // The aircraft has a saved profile, but this plan didn't use it — either the ID
        // is wrong or the plan was generated without it. Surface it rather than staying
        // silent (docs/decisions.md, fleet-simbrief-airframe entry, "make a wrong ID
        // visible").
        toast.warning(
          t('dispatchView.usedDefaultAirframe', {
            registration: matched.registration,
            airframeId: matched.simbriefAirframeId
          })
        )
      }
    }
  }

  async function handleFetch(): Promise<void> {
    setFetching(true)
    props.onOfpChange(null)
    setAirframeCapture(null)
    try {
      applyFetchedOfp(await window.winglog.dispatchFetchOfp())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setFetching(false)
    }
  }

  async function handleGenerate(): Promise<void> {
    const selected = aircraft.find((a) => a.id === planAircraftId)
    if (!selected || !depIcao || !destIcao) return
    setGenerating(true)
    props.onOfpChange(null)
    setAirframeCapture(null)
    try {
      const generated = await window.winglog.dispatchGenerateOfp({
        origIcao: depIcao,
        destIcao,
        icaoType: selected.icaoType,
        simbriefAirframeId: selected.simbriefAirframeId,
        simbriefType: selected.simbriefType,
        airlineIcao: airlineIcao || null,
        flightNumber: flightNumber || null,
        departure: departureUtc ? toSimBriefDeparture(departureUtc) : null,
        extra: dispatchOptionsToUrlParams(dispatchOptions)
      })
      applyFetchedOfp(generated)
      toast.success(t('dispatchView.planGenerated'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  async function handleSaveAirframe(): Promise<void> {
    if (!airframeCapture) return
    const target = aircraft.find((a) => a.id === airframeCapture.aircraftId)
    if (!target) return
    try {
      const updated = await window.winglog.aircraftUpdate({ ...target, simbriefAirframeId: airframeCapture.airframeId })
      setAircraft((current) => current.map((a) => (a.id === updated.id ? updated : a)))
      setAirframeCapture(null)
      toast.success(t('dispatchView.savedAirframeTo', { registration: updated.registration }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  // Fly creates a new flight, and the app only ever tracks one flight "in progress" at a
  // time (main/index.ts's flightCreate handler abandons whatever was already active or
  // planned) — so pressing Fly while Track already has something going on would silently
  // abandon it with no warning. Check first and confirm before doing anything destructive.
  async function handleFlyClick(): Promise<void> {
    if (!ofp || selectedAircraftId == null) return
    const [active, flights] = await Promise.all([
      window.winglog.trackingGetActive(),
      window.winglog.flightList()
    ])
    const activeFlight = active ? flights.find((f) => f.id === active.flightId) : undefined
    const otherPlanned = flights.filter((f) => f.status === 'planned')
    const warning = activeFlight
      ? t('dispatchView.willDeleteTracked', { label: flightLabel(activeFlight) })
      : otherPlanned.length === 1
        ? t('dispatchView.willAbandonOne', { label: flightLabel(otherPlanned[0]) })
        : otherPlanned.length > 1
          ? t('dispatchView.willAbandonMany', { count: otherPlanned.length })
          : null
    if (warning) {
      const ok = await confirm({
        title: t('dispatchView.flyThisPlanInstead'),
        description: warning,
        confirmLabel: t('dispatchView.fly')
      })
      if (!ok) return
    }
    await handleSaveFlight()
  }

  async function handleDiscardPlan(): Promise<void> {
    const ok = await confirm({
      title: t('dispatchView.discardThisPlan'),
      description: t('dispatchView.canFetchAgain'),
      confirmLabel: t('dispatchView.discardPlan'),
      destructive: true
    })
    if (!ok) return
    props.onOfpChange(null)
  }

  // Sibling of Logbook's handleViewOfpPdf (docs/plans/dispatch-action-buttons.md) — works
  // for a plan that's only fetched, not flown yet, since it passes the OFP JSON the
  // renderer already holds rather than looking a flight row up by id.
  async function handleViewOfpPdf(): Promise<void> {
    if (!ofp) return
    const opened = await window.winglog.dispatchOpenOfpPdf(ofp.ofpJson)
    if (!opened) toast.error(t('dispatchView.noOfpPdfAvailable'))
  }

  async function handleSaveFlight(): Promise<void> {
    if (!ofp || selectedAircraftId == null) return
    setSaving(true)
    try {
      await window.winglog.flightCreate({
        aircraftId: selectedAircraftId,
        flightNumber: ofp.flightNumber,
        depIcao: ofp.depIcao,
        arrIcao: ofp.arrIcao,
        altnIcao: ofp.altnIcao,
        routeString: ofp.routeString,
        cruiseAltM: ofp.cruiseAltM,
        schedOutUtc: ofp.schedOutUtc,
        schedInUtc: ofp.schedInUtc,
        fuelPlannedKg: ofp.fuelPlannedKg,
        pax: ofp.pax,
        cargoKg: ofp.cargoKg,
        zfwKg: ofp.zfwKg,
        towKg: ofp.towKg,
        ldwKg: ofp.ldwKg,
        ofpId: ofp.ofpId,
        ofpJson: ofp.ofpJson,
        selectedDepartureRunway: props.selection.departureRunway,
        selectedSidIdent: props.selection.sidIdent,
        selectedSidTransition: props.selection.sidTransition,
        selectedStarIdent: props.selection.starIdent,
        selectedStarTransition: props.selection.starTransition,
        selectedApproachIdent: props.selection.approachIdent,
        selectedApproachTransition: props.selection.approachTransition,
        selectedArrivalIcao: props.selection.arrivalIcao
      })
      // The OFP itself stays put — Dispatch doubles as a weights/info reference for
      // whatever's currently dispatched until it's overwritten by the next fetch (see
      // alreadyFlown below) or the app closes. Only the "start a new plan" side resets.
      props.onDispatchedOfpIdChange(ofp.ofpId)
      setSelectedAircraftId(null)
      setPlanAircraftId(null)
      setDepIcao('')
      setDestIcao('')
      setAirlineIcao('')
      setFlightNumber('')
      setDepartureUtc(null)
      setDispatchOptions(defaultDispatchOptions())
      props.onPlanned?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const metarAirports = ofp
    ? { depIcao: ofp.depIcao, arrIcao: ofp.arrIcao, altnIcao: ofp.altnIcao }
    : { depIcao: depIcao || null, arrIcao: destIcao || null, altnIcao: null }
  const alreadyFlown = ofp != null && ofp.ofpId === props.dispatchedOfpId

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('dispatchView.title')}</h1>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-72 max-w-md flex-1 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>{t('dispatchView.planAFlight')}</CardTitle>
              <CardAction>
                <Button type="button" variant="outline" size="sm" onClick={handleFetch} disabled={fetching || generating}>
                  {fetching ? t('dispatchView.fetching') : t('dispatchView.fetchLatestOfp')}
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>{t('dispatchView.aircraft')}</Label>
                <Select
                  value={planAircraftId != null ? String(planAircraftId) : undefined}
                  onValueChange={(v) => handlePlanAircraftChange(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('dispatchView.selectPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {aircraft.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {aircraftLabel(a)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('dispatchView.departure')}</Label>
                <AirportSearch value={depIcao} onChange={setDepIcao} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('dispatchView.destination')}</Label>
                <AirportSearch value={destIcao} onChange={setDestIcao} />
              </div>
              <div className="flex gap-3">
                <Label className="flex flex-1 flex-col items-start gap-1.5">
                  {t('dispatchView.airlineIcao')}
                  <Input
                    type="text"
                    value={airlineIcao}
                    onChange={(e) => setAirlineIcao(e.target.value.toUpperCase())}
                    placeholder={t('dispatchView.airlineIcaoPlaceholder')}
                  />
                </Label>
                <Label className="flex flex-1 flex-col items-start gap-1.5">
                  {t('dispatchView.flightNumber')}
                  <Input
                    type="text"
                    value={flightNumber}
                    onChange={(e) => setFlightNumber(e.target.value)}
                    placeholder={t('dispatchView.flightNumberPlaceholder')}
                  />
                </Label>
              </div>
              <Label className="flex flex-col items-start gap-1.5">
                {t('dispatchView.departureUtc')}
                <Input
                  type="datetime-local"
                  value={departureUtc ? toDatetimeLocalValue(departureUtc) : ''}
                  onChange={(e) => setDepartureUtc(fromDatetimeLocalValue(e.target.value))}
                />
              </Label>
              <div className="flex gap-2">
                {generationAvailable ? (
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={handleGenerate}
                    disabled={planAircraftId == null || !depIcao || !destIcao || generating}
                  >
                    {generating ? t('dispatchView.generating') : t('dispatchView.generate')}
                  </Button>
                ) : (
                  // Fallback for a build with no SimBrief API key available at all (e.g.
                  // built from source without .env set up) — Dispatch would otherwise have
                  // no way to create a plan.
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={handleOpenSimBrief}
                    disabled={planAircraftId == null || !depIcao || !destIcao}
                  >
                    {t('dispatchView.planOnSimBrief')}
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => setAdvancedOpen(true)}>
                  {countSetOptions(dispatchOptions) > 0
                    ? t('dispatchView.advancedWithCount', { count: countSetOptions(dispatchOptions) })
                    : t('dispatchView.advanced')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {ofp && (
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t('dispatchView.procedures')}</CardTitle>
              </CardHeader>
              <CardContent>
                <ProcedureSelector
                  airports={ofp}
                  selection={props.selection}
                  onSelectionChange={props.onSelectionChange}
                  liveWaypoints={liveWaypoints}
                />
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex min-w-72 flex-1 flex-col gap-4">
          <MetarPanel
            depIcao={metarAirports.depIcao}
            arrIcao={metarAirports.arrIcao}
            altnIcao={metarAirports.altnIcao}
            windSpeedUnit={props.windSpeedUnit}
          />

          {ofp ? (
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
                  <Button type="button" variant="outline" size="sm" onClick={handleViewOfpPdf}>
                    {t('dispatchView.viewOfpPdf')}
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {airframeCapture && (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 p-3 text-sm">
                    <span className="text-foreground">
                      {t('dispatchView.usedCustomAirframeNotSaved', {
                        registration: aircraft.find((a) => a.id === airframeCapture.aircraftId)?.registration
                      })}
                    </span>
                    <Button type="button" size="sm" variant="outline" onClick={handleSaveAirframe}>
                      {t('dispatchView.saveThisAirframe')}
                    </Button>
                  </div>
                )}
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <DetailField
                    label={t('dispatchView.fields.aircraftOfp')}
                    value={`${ofp.aircraftIcaoType} ${ofp.aircraftRegistration}`}
                  />
                  <DetailField
                    label={t('dispatchView.fields.cruiseAltitude')}
                    value={formatAltitude(mToFt(ofp.cruiseAltM), props.altitudeUnit)}
                  />
                  <DetailField
                    label={t('dispatchView.fields.scheduledOutIn')}
                    value={`${formatUtc(ofp.schedOutUtc)} / ${formatUtc(ofp.schedInUtc)}`}
                  />
                  <DetailField
                    label={t('dispatchView.fields.plannedFuel')}
                    value={formatWeight(ofp.fuelPlannedKg, props.weightUnit)}
                  />
                  {fuelOnBoardFlight && (
                    <DetailField
                      label={t('dispatchView.fields.fuelOnBoard')}
                      value={formatWeight(fuelOnBoardFlight.fuelInKg, props.weightUnit)}
                    />
                  )}
                  {upliftNeededKg != null && (
                    <DetailField
                      label={t('dispatchView.fields.upliftNeeded')}
                      value={formatWeight(upliftNeededKg, props.weightUnit)}
                    />
                  )}
                  <DetailField
                    label={t('dispatchView.fields.paxCargo')}
                    value={`${ofp.pax} / ${formatWeight(ofp.cargoKg, props.weightUnit)}`}
                  />
                  <DetailField
                    label={t('dispatchView.fields.zfwTowLdw')}
                    value={`${formatWeight(ofp.zfwKg, props.weightUnit)} / ${formatWeight(ofp.towKg, props.weightUnit)} / ${formatWeight(ofp.ldwKg, props.weightUnit)}`}
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
                            {formatAltitude(climb.toAltitudeFt, props.altitudeUnit, climb.native)}
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

                {!alreadyFlown && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label>{t('dispatchView.fleetAircraft')}</Label>
                      <Select
                        value={selectedAircraftId != null ? String(selectedAircraftId) : undefined}
                        onValueChange={(v) => setSelectedAircraftId(Number(v))}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder={t('dispatchView.selectPlaceholder')} />
                        </SelectTrigger>
                        <SelectContent>
                          {aircraft.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>
                              {a.registration} — {a.icaoType}
                              {a.registration === ofp.aircraftRegistration ? ` ${t('dispatchView.matched')}` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {ofp.matchedAircraftId == null && selectedAircraftId == null && (
                      <p className="text-sm text-muted-foreground">
                        {t('dispatchView.noFleetAircraftMatches', {
                          tail: ofp.aircraftRegistration || t('dispatchView.noneInOfp')
                        })}
                      </p>
                    )}
                  </>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="lg"
                    className="flex-[2]"
                    onClick={handleFlyClick}
                    disabled={saving || alreadyFlown || selectedAircraftId == null}
                  >
                    {saving ? t('dispatchView.starting') : t('dispatchView.fly')}
                  </Button>
                  <Button type="button" variant="outline" className="flex-1" onClick={handleDiscardPlan}>
                    {t('dispatchView.discardPlan')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">{t('dispatchView.planOrFetchPrompt')}</p>
          )}
        </div>
      </div>

      {confirmDialog}

      <DispatchAdvancedDialog
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        options={dispatchOptions}
        onOptionsChange={setDispatchOptions}
        flights={pastFlights}
      />
    </div>
  )
}
