/** The SID, STAR and approach dropdowns, from the sim's navdata. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NavdataProcedureOption, NavdataRunwayOption, ProcedureSelection } from '@shared/ipc'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { approachRunway, parseRouteProcedures, pickDefaultApproachIdentifier, type Waypoint } from './route'
import { arrivalAirport, type ProcedureAirports } from './procedure-selection'
import { displayIcao } from './display-icao'
import { uiMemory } from './ui-memory'
import { runAsync } from './report-error'

/** One procedure dropdown, backed by real navdata (docs/plans/navdata-without-navigraph.md
 *  Phase 3/5) — `options` is whatever's currently cached for this ICAO/kind. No "SimBrief
 *  default" sentinel any more (Phase 5): the value shown is always the real, current
 *  selection, seeded from SimBrief's own choice but otherwise indistinguishable from any
 *  other pick — same `undefined`-for-"nothing chosen" convention already used elsewhere in
 *  this app (e.g. DispatchView's own aircraft picker). */
const NONE_OPTION = '__none__'

/**
 * The browser's own dropdown, styled like the app's.
 *
 * @param props The value, the [value, label] choices, the change handler and whether it is disabled.
 * @returns The element.
 */
function NativePicker(props: {
  id: string
  value: string
  options: [string, string][]
  onChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <select
      id={props.id}
      className="h-11 w-full rounded-lg border border-input bg-background px-2.5 text-base text-foreground disabled:opacity-50"
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  )
}

/**
 * One procedure picker with a leading 'none' choice.
 *
 * @param props The label, value, options, change handler, whether it is disabled, and whether to use the device's own picker.
 * @returns The picker.
 */
function ProcedureSelect(props: {
  label: string
  value: string | null
  options: string[]
  onChange: (value: string | null) => void
  disabled?: boolean
  /** The browser's own `<select>`: on a phone it opens the device's picker, which scrolls and fits the screen. */
  native?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  if (props.native) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{props.label}</Label>
        <NativePicker
          id={id}
          value={props.value ?? ''}
          disabled={props.disabled}
          onChange={(v) => props.onChange(v === '' ? null : v)}
          options={[['', t('procedureSelector.none')], ...props.options.map((o): [string, string] => [o, o])]}
        />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{props.label}</Label>
      <Select
        value={props.value ?? undefined}
        onValueChange={(v) => props.onChange(v === NONE_OPTION ? null : v)}
        disabled={props.disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={t('procedureSelector.none')} />
        </SelectTrigger>
        <SelectContent>
          {/* Radix Select can't return to "nothing chosen" on its own, so an explicit item
           *  clears a pick made by mistake. */}
          <SelectItem value={NONE_OPTION}>{t('procedureSelector.none')}</SelectItem>
          {props.options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function transitionsFor(options: NavdataProcedureOption[], identifier: string | null): string[] {
  return [
    ...new Set(
      options
        .filter((o) => o.identifier === identifier)
        .map((o) => o.transition)
        .filter((t): t is string => t !== null)
    )
  ]
}

/**
 * The seven live procedure dropdowns — departure runway, SID (+transition), STAR
 * (+transition), approach (+transition) — shared between Dispatch and Track so both read
 * and write the exact same lifted selection (App.tsx) and never disagree about what's
 * currently chosen (docs/plans/navdata-without-navigraph.md, Phase 5). No save step: every
 * change here is immediately reflected wherever `selection` is used to build the live route
 * (useLiveWaypoints) — that's the caller's job, this component only edits the selection.
 *
 * @param props The flight's airports, the selection and its change handler.
 * @returns The element.
 */
export function ProcedureSelector(props: {
  airports: ProcedureAirports
  selection: ProcedureSelection
  onSelectionChange: (next: ProcedureSelection) => void
  /** The currently-assembled route — used only to find the current STAR's last waypoint,
   *  for the approach-transition auto-connect below. */
  liveWaypoints: Waypoint[]
  /** A phone-sized layout: Departure and Arrival as two tabs, each picker the device's own. */
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { airports, selection, onSelectionChange, liveWaypoints, compact = false } = props
  const [depRunways, setDepRunways] = useState<NavdataRunwayOption[]>([])
  const [sidOptions, setSidOptions] = useState<NavdataProcedureOption[]>([])
  const [starOptions, setStarOptions] = useState<NavdataProcedureOption[]>([])
  const [approachOptions, setApproachOptions] = useState<NavdataProcedureOption[]>([])
  // Which airport `approachOptions` were fetched for — switching to the alternate leaves the
  // destination's list in place until the new fetch lands, and the auto-default below must
  // not pick from that stale list.
  const [approachOptionsFor, setApproachOptionsFor] = useState('')
  const arrIcao = arrivalAirport(airports, selection)
  const altnIcao =
    airports.altnIcao && airports.altnIcao !== airports.arrIcao && airports.altnIcao !== 'ZZZZ'
      ? airports.altnIcao
      : null
  // Bumped once the background sim refresh below resolves, so the four cache-read effects
  // that follow (keyed on this alongside their own real deps) pick up whatever it just
  // fetched — no manual "Refresh from sim" button needed, this makes staying current
  // automatic instead.
  const [refreshedAt, setRefreshedAt] = useState(0)

  function set(patch: Partial<ProcedureSelection>): void {
    onSelectionChange({ ...selection, ...patch })
  }

  // Silent live-sim refresh on mount/airport change — failure is fine (the sim may not be
  // connected yet), the four lists below already loaded whatever's cached the moment they
  // mounted; this just tops them up once real navdata is available.
  useEffect(() => {
    // The destination and — when there is one and it's being used — the alternate.
    const toRefresh = new Set([airports.depIcao, airports.arrIcao, arrIcao])
    runAsync(
      'ProcedureSelector navdataRefreshAirport',
      Promise.allSettled([...toRefresh].map((icao) => winglogApi().navdataRefreshAirport(icao))).then(() =>
        setRefreshedAt((n) => n + 1)
      )
    )
    // Deliberately narrower than `airports` itself — `ofp`/`previewFlight` are recreated on
    // every parent render (a fresh object each time, even when depIcao/arrIcao haven't
    // changed), and this fetch must only re-fire when the airport pair actually changes.
  }, [airports.depIcao, airports.arrIcao, arrIcao])

  useEffect(() => {
    runAsync(
      'ProcedureSelector navdataListRunways',
      winglogApi().navdataListRunways(airports.depIcao).then(setDepRunways)
    )
  }, [airports.depIcao, refreshedAt])

  useEffect(() => {
    winglogApi()
      .navdataListSids(airports.depIcao, selection.departureRunway)
      .then(setSidOptions)
      .catch(() => setSidOptions([]))
  }, [airports.depIcao, selection.departureRunway, refreshedAt])

  // No separate arrival-runway selection any more — the currently-chosen approach's own
  // runway (encoded in its identifier) filters the STAR list, same as a real STAR only
  // serving certain parallel runways (confirmed live at VHHH, docs/navdata-notes.md).
  useEffect(() => {
    const runway = approachRunway(selection.approachIdent)
    winglogApi()
      .navdataListStars(arrIcao, runway)
      .then(setStarOptions)
      .catch(() => setStarOptions([]))
  }, [arrIcao, selection.approachIdent, refreshedAt])

  // Every approach at the field, unfiltered — there's no runway picker to filter by any
  // more, the approach dropdown itself is how a runway gets chosen.
  useEffect(() => {
    winglogApi()
      .navdataListApproaches(arrIcao, null)
      .then((options) => {
        setApproachOptions(options)
        setApproachOptionsFor(arrIcao)
      })
      .catch(() => {
        setApproachOptions([])
        setApproachOptionsFor(arrIcao)
      })
  }, [arrIcao, refreshedAt])

  // Auto-default the approach once real options exist and nothing's been chosen yet — see
  // pickDefaultApproachIdentifier's own doc comment for why this is a starting point, not a
  // guess to get right.
  const approachKey = `${airports.depIcao}>${arrIcao}|${airports.ofpJson?.slice(0, 300) ?? ''}`
  useEffect(() => {
    if (
      selection.approachIdent ||
      approachOptions.length === 0 ||
      approachOptionsFor !== arrIcao ||
      uiMemory().approachCleared.has(approachKey)
    )
      return
    // The OFP's planned runway is the filed destination's — not applicable to the alternate.
    const plannedRunway =
      arrIcao === airports.arrIcao ? parseRouteProcedures(airports.ofpJson).arrivalRunway : null
    const candidates = plannedRunway
      ? approachOptions.filter((o) => approachRunway(o.identifier) === plannedRunway)
      : approachOptions
    // Prefer an approach the STAR leads into (ZJSY: UPRS2C ends at SY498, ILS Z 08's entry).
    const starLastIdent = [...liveWaypoints].reverse().find((w) => w.segment === 'star')?.ident ?? null
    const pick = pickDefaultApproachIdentifier(candidates, starLastIdent)
    if (pick) set({ approachIdent: pick })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set is new every render; arrIcao and approachKey cover the airports
  }, [
    approachOptions,
    approachOptionsFor,
    arrIcao,
    selection.approachIdent,
    airports.ofpJson,
    approachKey,
    liveWaypoints
  ])

  // Auto-connect the approach's own entry transition to wherever the current STAR actually
  // ends, when one matches — confirmed live that a real APPROACH_TRANSITION's name is the
  // literal fix a STAR hands off at (docs/navdata-notes.md). Only fills an empty field,
  // never overwrites a deliberate choice.
  useEffect(() => {
    if (!selection.approachIdent || selection.approachTransition) return
    const starLastIdent = [...liveWaypoints].reverse().find((w) => w.segment === 'star')?.ident
    if (!starLastIdent) return
    const transitions = transitionsFor(approachOptions, selection.approachIdent)
    if (transitions.includes(starLastIdent)) set({ approachTransition: starLastIdent })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set is new every render
  }, [selection.approachIdent, selection.approachTransition, approachOptions, liveWaypoints])

  const arrivalAirportId = useId()
  const depRunwayIdents = depRunways.map((r) => r.ident)
  const sidIdentifiers = [...new Set(sidOptions.map((o) => o.identifier))]
  const starIdentifiers = [...new Set(starOptions.map((o) => o.identifier))]
  const approachIdentifiers = [...new Set(approachOptions.map((o) => o.identifier))]
  const sidTransitions = transitionsFor(sidOptions, selection.sidIdent)
  const starTransitions = transitionsFor(starOptions, selection.starIdent)
  const approachTransitions = transitionsFor(approachOptions, selection.approachIdent)

  /**
   * Switches the arrival dropdowns between the filed destination and the alternate.
   *
   * @param v 'alternate' or 'destination'.
   */
  function changeArrivalAirport(v: string): void {
    // The STAR/approach picked belong to the airport being left — start clean.
    set({
      arrivalIcao: v === 'alternate' ? altnIcao : null,
      starIdent: null,
      starTransition: null,
      approachIdent: null,
      approachTransition: null
    })
  }

  const departureColumn = (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t('procedureSelector.departure')}
      </span>
      <ProcedureSelect
        native={compact}
        label={t('procedureSelector.departureRunway')}
        value={selection.departureRunway}
        options={depRunwayIdents}
        onChange={(v) => set({ departureRunway: v })}
        disabled={depRunwayIdents.length === 0}
      />
      <ProcedureSelect
        native={compact}
        label={t('procedureSelector.sid')}
        value={selection.sidIdent}
        options={sidIdentifiers}
        onChange={(v) => set({ sidIdent: v, sidTransition: null })}
        disabled={sidIdentifiers.length === 0}
      />
      <ProcedureSelect
        native={compact}
        label={t('procedureSelector.sidTransition')}
        value={selection.sidTransition}
        options={sidTransitions}
        onChange={(v) => set({ sidTransition: v })}
        disabled={sidTransitions.length === 0}
      />
    </div>
  )
  const arrivalColumn = (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t('procedureSelector.arrival')}
      </span>
      {altnIcao && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={arrivalAirportId}>{t('procedureSelector.arrivalAirport')}</Label>
          {compact ? (
            <NativePicker
              id={arrivalAirportId}
              value={selection.arrivalIcao ? 'alternate' : 'destination'}
              options={[
                ['destination', t('procedureSelector.destination', { icao: displayIcao(airports.arrIcao) })],
                ['alternate', t('procedureSelector.alternate', { icao: altnIcao })]
              ]}
              onChange={changeArrivalAirport}
            />
          ) : (
            <Select
              value={selection.arrivalIcao ? 'alternate' : 'destination'}
              onValueChange={changeArrivalAirport}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="destination">
                  {t('procedureSelector.destination', { icao: displayIcao(airports.arrIcao) })}
                </SelectItem>
                <SelectItem value="alternate">
                  {t('procedureSelector.alternate', { icao: altnIcao })}
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <ProcedureSelect
        native={compact}
        label={t('procedureSelector.approach')}
        value={selection.approachIdent}
        options={approachIdentifiers}
        onChange={(v) => {
          if (v === null) uiMemory().approachCleared.add(approachKey)
          else uiMemory().approachCleared.delete(approachKey)
          set({ approachIdent: v, approachTransition: null })
        }}
        disabled={approachIdentifiers.length === 0}
      />
      <ProcedureSelect
        native={compact}
        label={t('procedureSelector.star')}
        value={selection.starIdent}
        options={starIdentifiers}
        onChange={(v) => set({ starIdent: v, starTransition: null })}
        disabled={starIdentifiers.length === 0}
      />
      <ProcedureSelect
        native={compact}
        label={t('procedureSelector.starTransition')}
        value={selection.starTransition}
        options={starTransitions}
        onChange={(v) => set({ starTransition: v })}
        disabled={starTransitions.length === 0}
      />
      <ProcedureSelect
        native={compact}
        label={t('procedureSelector.approachTransition')}
        value={selection.approachTransition}
        options={approachTransitions}
        onChange={(v) => set({ approachTransition: v })}
        disabled={approachTransitions.length === 0}
      />
    </div>
  )

  if (compact) {
    return (
      <Tabs defaultValue="departure">
        <TabsList className="w-full">
          <TabsTrigger value="departure">{t('procedureSelector.departure')}</TabsTrigger>
          <TabsTrigger value="arrival">{t('procedureSelector.arrival')}</TabsTrigger>
        </TabsList>
        <TabsContent value="departure">{departureColumn}</TabsContent>
        <TabsContent value="arrival">{arrivalColumn}</TabsContent>
      </Tabs>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {departureColumn}
        {arrivalColumn}
      </div>
    </div>
  )
}
