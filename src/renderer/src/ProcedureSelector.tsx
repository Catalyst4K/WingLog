import { useEffect, useState } from 'react'
import type { NavdataProcedureOption, NavdataRunwayOption, ProcedureSelection } from '@shared/ipc'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { approachRunway, parseRouteProcedures, type Waypoint } from './route'
import type { ProcedureAirports } from './procedureSelection'

/** One procedure dropdown, backed by real navdata (docs/plans/navdata-without-navigraph.md
 *  Phase 3/5) — `options` is whatever's currently cached for this ICAO/kind. No "SimBrief
 *  default" sentinel any more (Phase 5): the value shown is always the real, current
 *  selection, seeded from SimBrief's own choice but otherwise indistinguishable from any
 *  other pick — same `undefined`-for-"nothing chosen" convention already used elsewhere in
 *  this app (e.g. DispatchView's own aircraft picker). */
function ProcedureSelect(props: {
  label: string
  value: string | null
  options: string[]
  onChange: (value: string | null) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{props.label}</Label>
      <Select value={props.value ?? undefined} onValueChange={props.onChange} disabled={props.disabled}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
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

/** Among approaches for the planned runway, prefer ILS (always unsuffixed when present),
 *  then LOC, then whatever RNAV/other option sorts first — a reasonable starting point, not
 *  a correctness claim: no signal (SimBrief or navdata) says which of several same-runway
 *  approaches ATC will actually assign, since a real pilot doesn't know either until told
 *  during descent (docs/navdata-notes.md, 2026-09-08 approach-procedures entry). The point
 *  is a sane default that's instantly correctable from the dropdown, not a guess to get
 *  right. */
export function pickDefaultApproachIdentifier(options: NavdataProcedureOption[]): string | null {
  const identifiers = [...new Set(options.map((o) => o.identifier))].sort()
  if (identifiers.length === 0) return null
  return identifiers.find((id) => id.startsWith('ILS ')) ?? identifiers.find((id) => id.startsWith('LOC ')) ?? identifiers[0]!
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
 */
export function ProcedureSelector(props: {
  airports: ProcedureAirports
  selection: ProcedureSelection
  onSelectionChange: (next: ProcedureSelection) => void
  /** The currently-assembled route — used only to find the current STAR's last waypoint,
   *  for the approach-transition auto-connect below. */
  liveWaypoints: Waypoint[]
}): React.JSX.Element {
  const { airports, selection, onSelectionChange, liveWaypoints } = props
  const [depRunways, setDepRunways] = useState<NavdataRunwayOption[]>([])
  const [sidOptions, setSidOptions] = useState<NavdataProcedureOption[]>([])
  const [starOptions, setStarOptions] = useState<NavdataProcedureOption[]>([])
  const [approachOptions, setApproachOptions] = useState<NavdataProcedureOption[]>([])
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
    const { depIcao, arrIcao } = airports
    Promise.allSettled([window.winglog.navdataRefreshAirport(depIcao), window.winglog.navdataRefreshAirport(arrIcao)]).then(() =>
      setRefreshedAt((n) => n + 1)
    )
    // Deliberately narrower than `airports` itself — `ofp`/`previewFlight` are recreated on
    // every parent render (a fresh object each time, even when depIcao/arrIcao haven't
    // changed), and this fetch must only re-fire when the airport pair actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airports.depIcao, airports.arrIcao])

  useEffect(() => {
    window.winglog.navdataListRunways(airports.depIcao).then(setDepRunways)
  }, [airports.depIcao, refreshedAt])

  useEffect(() => {
    window.winglog
      .navdataListSids(airports.depIcao, selection.departureRunway)
      .then(setSidOptions)
      .catch(() => setSidOptions([]))
  }, [airports.depIcao, selection.departureRunway, refreshedAt])

  // No separate arrival-runway selection any more — the currently-chosen approach's own
  // runway (encoded in its identifier) filters the STAR list, same as a real STAR only
  // serving certain parallel runways (confirmed live at VHHH, docs/navdata-notes.md).
  useEffect(() => {
    const runway = approachRunway(selection.approachIdent)
    window.winglog
      .navdataListStars(airports.arrIcao, runway)
      .then(setStarOptions)
      .catch(() => setStarOptions([]))
  }, [airports.arrIcao, selection.approachIdent, refreshedAt])

  // Every approach at the field, unfiltered — there's no runway picker to filter by any
  // more, the approach dropdown itself is how a runway gets chosen.
  useEffect(() => {
    window.winglog
      .navdataListApproaches(airports.arrIcao, null)
      .then(setApproachOptions)
      .catch(() => setApproachOptions([]))
  }, [airports.arrIcao, refreshedAt])

  // Auto-default the approach once real options exist and nothing's been chosen yet — see
  // pickDefaultApproachIdentifier's own doc comment for why this is a starting point, not a
  // guess to get right.
  useEffect(() => {
    if (selection.approachIdent || approachOptions.length === 0) return
    const plannedRunway = parseRouteProcedures(airports.ofpJson).arrivalRunway
    const candidates = plannedRunway ? approachOptions.filter((o) => approachRunway(o.identifier) === plannedRunway) : approachOptions
    const pick = pickDefaultApproachIdentifier(candidates)
    if (pick) set({ approachIdent: pick })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approachOptions, selection.approachIdent, airports.ofpJson])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.approachIdent, selection.approachTransition, approachOptions, liveWaypoints])

  const depRunwayIdents = depRunways.map((r) => r.ident)
  const sidIdentifiers = [...new Set(sidOptions.map((o) => o.identifier))]
  const starIdentifiers = [...new Set(starOptions.map((o) => o.identifier))]
  const approachIdentifiers = [...new Set(approachOptions.map((o) => o.identifier))]
  const sidTransitions = transitionsFor(sidOptions, selection.sidIdent)
  const starTransitions = transitionsFor(starOptions, selection.starIdent)
  const approachTransitions = transitionsFor(approachOptions, selection.approachIdent)

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-3">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Departure</span>
          <ProcedureSelect
            label="Departure runway"
            value={selection.departureRunway}
            options={depRunwayIdents}
            onChange={(v) => set({ departureRunway: v })}
            disabled={depRunwayIdents.length === 0}
          />
          <ProcedureSelect
            label="SID"
            value={selection.sidIdent}
            options={sidIdentifiers}
            onChange={(v) => set({ sidIdent: v, sidTransition: null })}
            disabled={sidIdentifiers.length === 0}
          />
          <ProcedureSelect
            label="SID transition"
            value={selection.sidTransition}
            options={sidTransitions}
            onChange={(v) => set({ sidTransition: v })}
            disabled={sidTransitions.length === 0}
          />
        </div>
        <div className="flex flex-col gap-3">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Arrival</span>
          <ProcedureSelect
            label="Approach"
            value={selection.approachIdent}
            options={approachIdentifiers}
            onChange={(v) => set({ approachIdent: v, approachTransition: null })}
            disabled={approachIdentifiers.length === 0}
          />
          <ProcedureSelect
            label="STAR"
            value={selection.starIdent}
            options={starIdentifiers}
            onChange={(v) => set({ starIdent: v, starTransition: null })}
            disabled={starIdentifiers.length === 0}
          />
          <ProcedureSelect
            label="STAR transition"
            value={selection.starTransition}
            options={starTransitions}
            onChange={(v) => set({ starTransition: v })}
            disabled={starTransitions.length === 0}
          />
          <ProcedureSelect
            label="Approach transition"
            value={selection.approachTransition}
            options={approachTransitions}
            onChange={(v) => set({ approachTransition: v })}
            disabled={approachTransitions.length === 0}
          />
        </div>
      </div>
    </div>
  )
}
