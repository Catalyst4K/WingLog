import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import type { Aircraft, AltitudeUnit, DispatchOfp, FleetStats, Flight, WeightUnit } from '@shared/ipc'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AirportSearch } from './AirportSearch'
import { DispatchAdvancedDialog } from './DispatchAdvancedDialog'
import { countSetOptions, defaultDispatchOptions, dispatchOptionsToUrlParams, type DispatchOptions } from '@shared/dispatch-options'
import { defaultDepartureTime, fromDatetimeLocalValue, toDatetimeLocalValue, toSimBriefDeparture } from './dispatch-time'
import { MetarPanel } from './MetarPanel'
import { parseRouteProcedures, type RouteProcedures } from './route'
import { formatAltitude, formatWeight, mToFt } from './units'

const NO_PROCEDURES: RouteProcedures = {
  departureRunway: null,
  sidIdent: null,
  sidTransition: null,
  starIdent: null,
  starTransition: null,
  arrivalRunway: null
}

/** One procedure dropdown. Real alternates need real navdata (blocked on Navigraph —
 *  docs/plans/sid-star-selection.md), so today each is autofilled with SimBrief's own
 *  choice and disabled when there isn't one — the map already colors SID/STAR waypoints
 *  by segment (FlightMap.tsx), so this box and the map already agree on the single value
 *  there is to show. Kept as a real Select (not a plain label) so a Navigraph-backed list
 *  of alternates drops in later without reshaping this box. */
function ProcedureSelect(props: { label: string; value: string | null; onChange: (value: string) => void }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{props.label}</Label>
      <Select value={props.value ?? undefined} onValueChange={props.onChange} disabled={props.value == null}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>{props.value != null && <SelectItem value={props.value}>{props.value}</SelectItem>}</SelectContent>
      </Select>
    </div>
  )
}

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
}): React.JSX.Element {
  const { ofp } = props
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [fleetStats, setFleetStats] = useState<FleetStats[]>([])
  const [pastFlights, setPastFlights] = useState<Flight[]>([])
  const [dispatchOptions, setDispatchOptions] = useState<DispatchOptions>(defaultDispatchOptions())
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selectedAircraftId, setSelectedAircraftId] = useState<number | null>(null)
  const [planAircraftId, setPlanAircraftId] = useState<number | null>(null)
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
  // Set only when Fly would abandon a flight Track already has in progress — see
  // handleFlyClick. Holds the warning text to show; null means no confirmation needed.
  const [flyWarning, setFlyWarning] = useState<string | null>(null)
  // Set after a fetch whose OFP was generated against a custom airframe that differs from
  // (or is missing on) the matched fleet aircraft — offered, not applied silently, same
  // as the registration-match heuristic (docs/decisions.md, fleet-simbrief-airframe entry).
  const [airframeCapture, setAirframeCapture] = useState<{ aircraftId: number; airframeId: string } | null>(null)
  // Departure/arrival runway, SID/STAR and their transitions — autofilled from whatever
  // SimBrief chose each time a new OFP comes in, independently editable per field
  // thereafter (see ProcedureSelect's doc comment for why "editable" means one option today).
  // Re-derived during render (not an effect) when the OFP identity changes, per React's own
  // "adjusting state when a prop changes" pattern — an effect here would setState after an
  // extra render, showing the previous plan's procedures for one frame.
  const [procedures, setProcedures] = useState<RouteProcedures>(NO_PROCEDURES)
  const [proceduresForOfpId, setProceduresForOfpId] = useState<string | null>(null)
  if ((ofp?.ofpId ?? null) !== proceduresForOfpId) {
    setProceduresForOfpId(ofp?.ofpId ?? null)
    setProcedures(ofp ? parseRouteProcedures(ofp.ofpJson) : NO_PROCEDURES)
  }

  useEffect(() => {
    window.flightdeck.aircraftList().then(setAircraft)
    window.flightdeck.logbookFleetStats().then(setFleetStats)
    window.flightdeck.dispatchGenerationAvailable().then(setGenerationAvailable)
    // Source list for the advanced dialog's "Load settings from a previous flight" —
    // flightList already returns newest-first (docs/decisions.md).
    window.flightdeck.flightList().then(setPastFlights)
  }, [])

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
    await window.flightdeck.dispatchOpenSimBrief({
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
          `This plan used SimBrief's default airframe, not ${matched.registration}'s saved profile (${matched.simbriefAirframeId}) — the saved ID may be wrong.`
        )
      }
    }
  }

  async function handleFetch(): Promise<void> {
    setFetching(true)
    props.onOfpChange(null)
    setAirframeCapture(null)
    try {
      applyFetchedOfp(await window.flightdeck.dispatchFetchOfp())
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
      const generated = await window.flightdeck.dispatchGenerateOfp({
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
      toast.success('Plan generated.')
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
      const updated = await window.flightdeck.aircraftUpdate({ ...target, simbriefAirframeId: airframeCapture.airframeId })
      setAircraft((current) => current.map((a) => (a.id === updated.id ? updated : a)))
      setAirframeCapture(null)
      toast.success(`Saved this airframe to ${updated.registration}.`)
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
      window.flightdeck.trackingGetActive(),
      window.flightdeck.flightList()
    ])
    const activeFlight = active ? flights.find((f) => f.id === active.flightId) : undefined
    const otherPlanned = flights.filter((f) => f.status === 'planned')
    if (activeFlight) {
      setFlyWarning(
        `This will abandon the flight currently being tracked, ${activeFlight.flightNumber ?? `#${activeFlight.id}`}.`
      )
    } else if (otherPlanned.length > 0) {
      setFlyWarning(
        otherPlanned.length === 1
          ? `This will abandon the other planned flight, ${otherPlanned[0].flightNumber ?? `#${otherPlanned[0].id}`}.`
          : `This will abandon ${otherPlanned.length} other planned flights.`
      )
    } else {
      await handleSaveFlight()
    }
  }

  async function handleConfirmFly(): Promise<void> {
    setFlyWarning(null)
    await handleSaveFlight()
  }

  async function handleSaveFlight(): Promise<void> {
    if (!ofp || selectedAircraftId == null) return
    setSaving(true)
    try {
      await window.flightdeck.flightCreate({
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
        ofpJson: ofp.ofpJson
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
      <h1 className="font-heading text-2xl font-semibold text-foreground">Dispatch</h1>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-72 max-w-md flex-1 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Plan a flight</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Aircraft</Label>
                <Select
                  value={planAircraftId != null ? String(planAircraftId) : undefined}
                  onValueChange={(v) => handlePlanAircraftChange(Number(v))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="— select —" />
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
                <Label>Departure</Label>
                <AirportSearch value={depIcao} onChange={setDepIcao} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Destination</Label>
                <AirportSearch value={destIcao} onChange={setDestIcao} />
              </div>
              <div className="flex gap-3">
                <Label className="flex flex-1 flex-col items-start gap-1.5">
                  Airline ICAO
                  <Input
                    type="text"
                    value={airlineIcao}
                    onChange={(e) => setAirlineIcao(e.target.value.toUpperCase())}
                    placeholder="e.g. BAW"
                  />
                </Label>
                <Label className="flex flex-1 flex-col items-start gap-1.5">
                  Flight number
                  <Input
                    type="text"
                    value={flightNumber}
                    onChange={(e) => setFlightNumber(e.target.value)}
                    placeholder="e.g. 02"
                  />
                </Label>
              </div>
              <Label className="flex flex-col items-start gap-1.5">
                Departure (UTC/Z)
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
                    {generating ? 'Generating…' : 'Generate…'}
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
                    Plan on SimBrief…
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => setAdvancedOpen(true)}>
                  Advanced{countSetOptions(dispatchOptions) > 0 ? ` (${countSetOptions(dispatchOptions)})` : ''}
                </Button>
              </div>
            </CardContent>
          </Card>

          {ofp && (
            <Card size="sm">
              <CardHeader>
                <CardTitle>Procedures</CardTitle>
                <CardDescription>
                  SimBrief's chosen runways, SID and STAR. Swapping to a different procedure needs real
                  navdata, which isn't wired in yet — see docs/plans/sid-star-selection.md.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <ProcedureSelect
                  label="Departure runway"
                  value={procedures.departureRunway}
                  onChange={(v) => setProcedures((p) => ({ ...p, departureRunway: v }))}
                />
                <ProcedureSelect
                  label="Arrival runway"
                  value={procedures.arrivalRunway}
                  onChange={(v) => setProcedures((p) => ({ ...p, arrivalRunway: v }))}
                />
                <ProcedureSelect
                  label="SID"
                  value={procedures.sidIdent}
                  onChange={(v) => setProcedures((p) => ({ ...p, sidIdent: v }))}
                />
                <ProcedureSelect
                  label="STAR"
                  value={procedures.starIdent}
                  onChange={(v) => setProcedures((p) => ({ ...p, starIdent: v }))}
                />
                <ProcedureSelect
                  label="SID transition"
                  value={procedures.sidTransition}
                  onChange={(v) => setProcedures((p) => ({ ...p, sidTransition: v }))}
                />
                <ProcedureSelect
                  label="STAR transition"
                  value={procedures.starTransition}
                  onChange={(v) => setProcedures((p) => ({ ...p, starTransition: v }))}
                />
              </CardContent>
            </Card>
          )}

          <Card size="sm">
            <CardHeader>
              <CardTitle>Or import an existing plan</CardTitle>
              <CardDescription>
                Pulls your latest OFP from SimBrief — useful if you planned it there directly, or want
                to re-fetch after adjusting it on SimBrief's site.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" variant="outline" size="sm" onClick={handleFetch} disabled={fetching || generating}>
                {fetching ? 'Fetching…' : 'Fetch latest OFP'}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-72 flex-1 flex-col gap-4">
          <MetarPanel depIcao={metarAirports.depIcao} arrIcao={metarAirports.arrIcao} altnIcao={metarAirports.altnIcao} />

          {ofp ? (
            <Card>
              <CardHeader>
                <CardTitle>
                  {ofp.flightNumber}: {ofp.depIcao} → {ofp.arrIcao} (altn {ofp.altnIcao})
                </CardTitle>
                <CardAction className="flex items-center gap-2">
                  {alreadyFlown && <Badge variant="secondary">Flying</Badge>}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Unload flight plan"
                    title="Unload flight plan"
                    onClick={() => props.onOfpChange(null)}
                  >
                    <X />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {airframeCapture && (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/50 p-3 text-sm">
                    <span className="text-foreground">
                      This plan used a custom SimBrief airframe not saved to{' '}
                      {aircraft.find((a) => a.id === airframeCapture.aircraftId)?.registration}.
                    </span>
                    <Button type="button" size="sm" variant="outline" onClick={handleSaveAirframe}>
                      Save this airframe
                    </Button>
                  </div>
                )}
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <DetailField
                    label="Aircraft (OFP)"
                    value={`${ofp.aircraftIcaoType} ${ofp.aircraftRegistration}`}
                  />
                  <DetailField
                    label="Cruise altitude"
                    value={formatAltitude(mToFt(ofp.cruiseAltM), props.altitudeUnit)}
                  />
                  <DetailField
                    label="Scheduled out / in"
                    value={`${formatUtc(ofp.schedOutUtc)} / ${formatUtc(ofp.schedInUtc)}`}
                  />
                  <DetailField label="Planned fuel" value={formatWeight(ofp.fuelPlannedKg, props.weightUnit)} />
                  <DetailField
                    label="Pax / cargo"
                    value={`${ofp.pax} / ${formatWeight(ofp.cargoKg, props.weightUnit)}`}
                  />
                  <DetailField
                    label="ZFW / TOW / LDW"
                    value={`${formatWeight(ofp.zfwKg, props.weightUnit)} / ${formatWeight(ofp.towKg, props.weightUnit)} / ${formatWeight(ofp.ldwKg, props.weightUnit)}`}
                  />
                  <DetailField label="Cost index" value={ofp.costIndex ?? '—'} />
                </dl>
                <div className="flex flex-col gap-1.5 text-sm">
                  <span className="text-muted-foreground">Steps</span>
                  {ofp.stepClimbs.length === 0 ? (
                    <span className="text-foreground">None</span>
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
                  <span className="text-muted-foreground">Route</span>
                  <p className="max-h-16 overflow-auto text-foreground">{ofp.routeString}</p>
                </div>

                {!alreadyFlown && (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <Label>Fleet aircraft</Label>
                      <Select
                        value={selectedAircraftId != null ? String(selectedAircraftId) : undefined}
                        onValueChange={(v) => setSelectedAircraftId(Number(v))}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="— select —" />
                        </SelectTrigger>
                        <SelectContent>
                          {aircraft.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>
                              {a.registration} — {a.icaoType}
                              {a.registration === ofp.aircraftRegistration ? ' (matched)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {ofp.matchedAircraftId == null && selectedAircraftId == null && (
                      <p className="text-sm text-muted-foreground">
                        No fleet aircraft matches tail {ofp.aircraftRegistration || '(none in OFP)'} — pick
                        one manually.
                      </p>
                    )}

                    <Button type="button" onClick={handleFlyClick} disabled={saving || selectedAircraftId == null}>
                      {saving ? 'Starting…' : 'Fly'}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">Plan or fetch a flight to see its details here.</p>
          )}
        </div>
      </div>

      <AlertDialog open={flyWarning !== null} onOpenChange={(open) => !open && setFlyWarning(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fly this plan instead?</AlertDialogTitle>
            <AlertDialogDescription>{flyWarning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmFly}>Fly</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
