/** The Dispatch tab: plan or fetch a SimBrief flight, pick its aircraft, and fly it. */

import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { AltitudeUnit, DispatchOfp, ProcedureSelection, WeightUnit, WindSpeedUnit } from '@shared/ipc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DispatchAdvancedDialog } from './DispatchAdvancedDialog'
import { useConfirm } from './hooks/use-confirm'
import { MetarPanel } from './MetarPanel'
import { ProcedureSelector } from './ProcedureSelector'
import { flightLabel } from './flight-label'
import { useLiveWaypoints } from './procedure-selection'
import { OfpCard, PlanFlightCard } from './dispatch/DispatchCards'
import { flightFromOfp, planRequest, useDispatchLists, usePlanForm } from './dispatch/use-dispatch-state'

/**
 * The Dispatch tab.
 *
 * @param props The unit settings, the OFP in progress and its change handler, and what to do once planned.
 * @returns The element.
 */
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
  const form = usePlanForm()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selectedAircraftId, setSelectedAircraftId] = useState<number | null>(null)
  const [fetching, setFetching] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirm, confirmDialog] = useConfirm()
  // Set after a fetch whose OFP was generated against a custom airframe that differs from
  // (or is missing on) the matched fleet aircraft — offered, not applied silently, same
  // as the registration-match heuristic (docs/decisions.md, fleet-simbrief-airframe entry).
  const [airframeCapture, setAirframeCapture] = useState<{ aircraftId: number; airframeId: string } | null>(
    null
  )
  // The live route with the current selection spliced in — single source of truth this and
  // Track's map both render from (docs/plans/navdata-without-navigraph.md, Phase 5).
  const liveWaypoints = useLiveWaypoints(ofp, props.selection)
  // Called after useLiveWaypoints, so the tab's loads start in the same order as before.
  const { aircraft, setAircraft, lastParked, fleetStats, pastFlights, generationAvailable } =
    useDispatchLists()

  function handlePlanAircraftChange(id: number): void {
    form.chooseAircraft(id, aircraft, fleetStats)
    setSelectedAircraftId(id)
  }

  async function handleOpenSimBrief(): Promise<void> {
    const selected = aircraft.find((a) => a.id === form.planAircraftId)
    if (!selected || !form.depIcao || !form.destIcao) return
    await window.winglog.dispatchOpenSimBrief(planRequest(form, selected))
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
    const selected = aircraft.find((a) => a.id === form.planAircraftId)
    if (!selected || !form.depIcao || !form.destIcao) return
    setGenerating(true)
    props.onOfpChange(null)
    setAirframeCapture(null)
    try {
      applyFetchedOfp(await window.winglog.dispatchGenerateOfp(planRequest(form, selected)))
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
      const updated = await window.winglog.aircraftUpdate({
        ...target,
        simbriefAirframeId: airframeCapture.airframeId
      })
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
      await window.winglog.flightCreate(flightFromOfp(ofp, selectedAircraftId, props.selection))
      // The OFP itself stays put — Dispatch doubles as a weights/info reference for
      // whatever's currently dispatched until it's overwritten by the next fetch (see
      // alreadyFlown below) or the app closes. Only the "start a new plan" side resets.
      props.onDispatchedOfpIdChange(ofp.ofpId)
      setSelectedAircraftId(null)
      form.reset()
      props.onPlanned?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const metarAirports = ofp
    ? { depIcao: ofp.depIcao, arrIcao: ofp.arrIcao, altnIcao: ofp.altnIcao }
    : { depIcao: form.depIcao || null, arrIcao: form.destIcao || null, altnIcao: null }
  const alreadyFlown = ofp != null && ofp.ofpId === props.dispatchedOfpId

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('dispatchView.title')}</h1>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-72 max-w-md flex-1 flex-col gap-4">
          <PlanFlightCard
            form={form}
            aircraft={aircraft}
            lastParked={lastParked}
            generationAvailable={generationAvailable}
            fetching={fetching}
            generating={generating}
            onChooseAircraft={handlePlanAircraftChange}
            onFetch={handleFetch}
            onGenerate={handleGenerate}
            onOpenSimBrief={handleOpenSimBrief}
            onAdvanced={() => setAdvancedOpen(true)}
          />

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
            <OfpCard
              ofp={ofp}
              aircraft={aircraft}
              lastParked={lastParked}
              weightUnit={props.weightUnit}
              altitudeUnit={props.altitudeUnit}
              alreadyFlown={alreadyFlown}
              saving={saving}
              airframeCapture={airframeCapture}
              selectedAircraftId={selectedAircraftId}
              onSelectAircraft={setSelectedAircraftId}
              onViewOfpPdf={handleViewOfpPdf}
              onSaveAirframe={handleSaveAirframe}
              onFly={handleFlyClick}
              onDiscard={handleDiscardPlan}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t('dispatchView.planOrFetchPrompt')}</p>
          )}
        </div>
      </div>

      {confirmDialog}

      <DispatchAdvancedDialog
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        options={form.dispatchOptions}
        onOptionsChange={form.setDispatchOptions}
        flights={pastFlights}
      />
    </div>
  )
}
