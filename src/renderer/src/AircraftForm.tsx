import { useEffect, useState } from 'react'
import type { Aircraft, AircraftTypeOption, AirlineOption, NewAircraft, SimbriefAirframeOption } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AirportSearch } from './AirportSearch'
import { Combobox } from './components/Combobox'

interface FormState {
  registration: string
  icaoType: string
  operator: string
  operatorIata: string
  operatorIcao: string
  simbriefAirframeId: string
  simbriefType: string
  currentIcao: string
}

const EMPTY_FORM: FormState = {
  registration: '',
  icaoType: '',
  operator: '',
  operatorIata: '',
  operatorIcao: '',
  simbriefAirframeId: '',
  simbriefType: '',
  currentIcao: ''
}

function toFormState(a: Aircraft): FormState {
  return {
    registration: a.registration,
    icaoType: a.icaoType,
    operator: a.operator ?? '',
    operatorIata: a.operatorIata ?? '',
    operatorIcao: a.operatorIcao ?? '',
    simbriefAirframeId: a.simbriefAirframeId ?? '',
    simbriefType: a.simbriefType ?? '',
    currentIcao: a.currentIcao ?? ''
  }
}

function toNewAircraft(f: FormState): NewAircraft {
  // `null`, not `undefined` — aircraft-validation.ts's parseAircraftInput treats the two
  // differently on purpose (confirmed live, docs/plans/simbrief-airframe-picker.md):
  // `null` means "clear this field", `undefined` means "field wasn't in the payload at
  // all, leave it alone". Sending `undefined` here for an intentionally-blanked field
  // would look identical to that second case and silently fail to clear anything.
  const str = (s: string): string | null => (s.trim() === '' ? null : s.trim())

  return {
    registration: f.registration.trim(),
    icaoType: f.icaoType.trim(),
    operator: str(f.operator),
    operatorIata: str(f.operatorIata),
    operatorIcao: str(f.operatorIcao),
    simbriefAirframeId: str(f.simbriefAirframeId),
    simbriefType: str(f.simbriefType),
    currentIcao: str(f.currentIcao)
  }
}

function Field(props: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
}): React.JSX.Element {
  return (
    <Label className="flex flex-col items-start gap-1.5">
      {props.label}
      <Input type="text" value={props.value} required={props.required} onChange={(e) => props.onChange(e.target.value)} />
    </Label>
  )
}

/** A short label for one dropdown row — the stock entry gets a fixed label (nothing to
 *  attribute it to), a community entry prefers its parsed developer, falling back to the
 *  raw comment for the ~3% that don't match SimBrief's usual naming shape (docs/plans/
 *  simbrief-airframe-picker.md). */
function optionLabel(o: SimbriefAirframeOption): string {
  if (o.isDefault) return `SimBrief default (${o.engines})`
  return `${o.developer ?? o.comments} — ${o.engines}`
}

export function AircraftForm(props: {
  initial?: Aircraft
  onSubmit: (data: NewAircraft) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const [form, setForm] = useState<FormState>(props.initial ? toFormState(props.initial) : EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [lookupStatus, setLookupStatus] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  // Not visible form fields — the user never types these directly, they only ever come
  // from a registration lookup or the SimBrief airframe picker below (docs/plans/
  // fleet-redesign.md #3, docs/plans/simbrief-airframe-picker.md). Kept out of FormState
  // so toFormState/toNewAircraft don't need to round-trip values nothing renders as input.
  const [photoThumbnailUrl, setPhotoThumbnailUrl] = useState<string | null>(props.initial?.photoThumbnailUrl ?? null)
  const [airframeDeveloper, setAirframeDeveloper] = useState<string | null>(
    props.initial?.simbriefAirframeDeveloper ?? null
  )
  const [airframeEngines, setAirframeEngines] = useState<string | null>(props.initial?.simbriefAirframeEngines ?? null)
  const [airframeRegistration, setAirframeRegistration] = useState<string | null>(
    props.initial?.simbriefAirframeRegistration ?? null
  )

  const [airframeOptions, setAirframeOptions] = useState<SimbriefAirframeOption[]>([])
  const [loadingAirframeOptions, setLoadingAirframeOptions] = useState(false)
  const [selectedOptionKey, setSelectedOptionKey] = useState<string | null>(null)
  const [creatingAirframe, setCreatingAirframe] = useState(false)

  // A bare 2-3 letter fragment mid-edit has no real entry to find anyway, and SimBrief's
  // own type codes are always the full 4-character ICAO designator — computed during
  // render so the too-short case never needs its own setState, in an effect or otherwise.
  const trimmedIcaoType = form.icaoType.trim().toUpperCase()
  const typeTooShort = trimmedIcaoType.length < 3
  const displayedOptions = typeTooShort ? [] : airframeOptions
  const selectedOption = selectedOptionKey !== null ? displayedOptions[Number(selectedOptionKey)] : undefined

  // The dropdown's own selection can't survive a type change (its options are about to be
  // replaced entirely) — adjusted during render, React's own documented pattern for state
  // that depends on another value changing, rather than via an effect.
  const [committedIcaoTypeForOptions, setCommittedIcaoTypeForOptions] = useState(trimmedIcaoType)
  if (trimmedIcaoType !== committedIcaoTypeForOptions) {
    setCommittedIcaoTypeForOptions(trimmedIcaoType)
    setSelectedOptionKey(null)
  }

  // Debounced the same way Combobox.tsx's own search-as-you-type effect is — icaoType is
  // a controlled input that changes on every keystroke, and a real fetch per keystroke
  // would both hammer SimBrief's endpoint and mostly fetch for a type the pilot hasn't
  // finished typing yet.
  useEffect(() => {
    if (trimmedIcaoType.length < 3) return
    let cancelled = false
    const timer = setTimeout(() => {
      setLoadingAirframeOptions(true)
      window.flightdeck
        .simbriefAirframesForType(trimmedIcaoType)
        .then((options) => {
          if (!cancelled) setAirframeOptions(options)
        })
        .finally(() => {
          if (!cancelled) setLoadingAirframeOptions(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmedIcaoType])

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  /** The raw text fields stay directly editable (never blocked), but typing over a value
   *  the picker set invalidates its cached label — showing a stale developer/engine
   *  label next to a hand-edited id/type would be actively misleading. */
  function handleManualSimbriefAirframeIdChange(value: string): void {
    set('simbriefAirframeId', value)
    setAirframeDeveloper(null)
    setAirframeEngines(null)
    setAirframeRegistration(null)
  }

  function handleManualSimbriefTypeChange(value: string): void {
    set('simbriefType', value.toUpperCase())
    setAirframeDeveloper(null)
    setAirframeEngines(null)
    setAirframeRegistration(null)
  }

  function handleSelectAirframeOption(key: string): void {
    setSelectedOptionKey(key)
    const option = displayedOptions[Number(key)]
    if (!option) return
    if (option.isDefault) {
      set('simbriefType', '')
      set('simbriefAirframeId', '')
      setAirframeDeveloper(null)
      setAirframeEngines(null)
      setAirframeRegistration(null)
      return
    }
    set('simbriefType', option.simbriefType)
    setAirframeDeveloper(option.developer)
    setAirframeEngines(option.engines)
    setAirframeRegistration(option.registration)
    // A previously-created custom airframe was for whichever option was selected before —
    // switching options invalidates it rather than leaving a mismatched id in place.
    set('simbriefAirframeId', '')
  }

  async function handleCreateCustomAirframe(): Promise<void> {
    if (!selectedOption?.shareUrl) return
    setCreatingAirframe(true)
    setLookupStatus(null)
    try {
      const result = await window.flightdeck.simbriefCreateCustomAirframe(selectedOption.shareUrl)
      if (result) {
        set('simbriefAirframeId', result)
        setLookupStatus('Custom airframe saved.')
      } else {
        setLookupStatus('No airframe was saved — the window was closed before finishing.')
      }
    } finally {
      setCreatingAirframe(false)
    }
  }

  async function handleLookup(): Promise<void> {
    const registration = form.registration.trim()
    if (!registration) {
      setLookupStatus('Enter a registration first.')
      return
    }
    setLookingUp(true)
    setLookupStatus(null)
    try {
      const result = await window.flightdeck.aircraftLookupByRegistration(registration)
      if (!result) {
        setLookupStatus(`No match for "${registration}" — search for the type below.`)
        return
      }
      // adsbdb also returns the operator's actual ICAO code — resolve the exact vendored
      // airline entry from that (canonical name + IATA, for a logo) rather than fuzzy-
      // matching adsbdb's free-text operator name against it, which breaks on real
      // mismatches (adsbdb's "Cathay Pacific Airways" vs. the vendored "Cathay Pacific" —
      // a shorter name can never substring-match a longer query). Uses the exact-ICAO
      // lookup, not airlineSearch's fuzzy substring match — a short code like "SIA" can
      // have dozens of unrelated substring matches and never reach its own exact row
      // within airlineSearch's result cap (flight-test-findings-2026-09-06.md #1).
      const matchedAirline: AirlineOption | undefined = result.operatorIcao
        ? await window.flightdeck.airlineFindByIcao(result.operatorIcao)
        : undefined
      // Fills blanks only — never overwrites something already typed/edited.
      const hadSimbriefType = form.simbriefType.trim() !== ''
      setForm((current) => {
        const fillOperator = !current.operator
        return {
          ...current,
          icaoType: current.icaoType || result.icaoType,
          operator: fillOperator ? (matchedAirline?.name ?? result.operator ?? current.operator) : current.operator,
          operatorIata: fillOperator ? (matchedAirline?.iata ?? '') : current.operatorIata,
          operatorIcao: fillOperator ? (matchedAirline?.icao ?? result.operatorIcao ?? '') : current.operatorIcao
        }
      })
      // Same "fill blanks only" restraint as the operator fields above — a re-run
      // shouldn't clobber a photo already resolved by an earlier lookup.
      if (photoThumbnailUrl === null && result.photoThumbnailUrl) {
        setPhotoThumbnailUrl(result.photoThumbnailUrl)
      }
      // Autofills the SimBrief type with the closest match to the real-world type adsbdb
      // just reported (docs/plans/simbrief-airframe-picker.md) — "closest" in practice
      // means "does SimBrief recognise this exact ICAO code at all", since adsbdb gives no
      // free-text model name to fuzzy-match against if it doesn't. Only when nothing was
      // already set — same restraint as every other field Lookup touches.
      if (!hadSimbriefType) {
        window.flightdeck.simbriefAirframesForType(result.icaoType).then((options) => {
          if (options.some((o) => o.isDefault)) {
            setForm((current) => (current.simbriefType.trim() !== '' ? current : { ...current, simbriefType: result.icaoType }))
          }
        })
      }
      setLookupStatus(`Found: ${result.operator ?? 'unknown operator'}, ${result.icaoType}`)
    } catch (err) {
      setLookupStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLookingUp(false)
    }
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await props.onSubmit({
        ...toNewAircraft(form),
        photoThumbnailUrl,
        simbriefAirframeDeveloper: airframeDeveloper,
        simbriefAirframeEngines: airframeEngines,
        simbriefAirframeRegistration: airframeRegistration
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-5">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Label className="flex flex-col items-start gap-1.5">
        Registration
        <div className="flex w-full gap-1.5">
          <Input
            type="text"
            value={form.registration}
            required
            onChange={(e) => set('registration', e.target.value)}
            className="flex-1"
          />
          <Button type="button" variant="outline" size="sm" onClick={handleLookup} disabled={lookingUp}>
            {lookingUp ? '…' : 'Look up'}
          </Button>
        </div>
      </Label>

      {lookupStatus && <p className="text-sm text-muted-foreground">{lookupStatus}</p>}

      <div className="flex flex-col gap-1.5">
        <Label>ICAO type</Label>
        <Combobox
          value={form.icaoType}
          onChange={(value) => set('icaoType', value.toUpperCase())}
          search={(query) => window.flightdeck.aircraftTypeSearch(query)}
          getOptionKey={(r: AircraftTypeOption) => `${r.icaoType}-${r.manufacturer}-${r.model}`}
          getOptionValue={(r) => r.icaoType}
          getOptionLabel={(r) => `${r.manufacturer} — ${r.model} (${r.icaoType})`}
          placeholder="e.g. A350, Boeing, B77W, or type an ICAO code"
        />
        <p className="text-xs text-muted-foreground">
          Registration lookup and aircraft type data via adsbdb.com (PlaneBase). Aircraft photos via
          airport-data.com.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Airline</Label>
        <Combobox
          value={form.operator}
          onChange={(value) => {
            set('operator', value)
            set('operatorIata', '')
            set('operatorIcao', '')
          }}
          onSelectItem={(item: AirlineOption) => {
            set('operatorIata', item.iata)
            set('operatorIcao', item.icao)
          }}
          search={(query) => window.flightdeck.airlineSearch(query)}
          getOptionKey={(r: AirlineOption) => `${r.icao}-${r.name}`}
          getOptionValue={(r) => r.name}
          getOptionLabel={(r) => `${r.name} (${r.icao}${r.iata ? `/${r.iata}` : ''})`}
          placeholder="e.g. British Airways, BAW, or type a name"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Profile</Label>
        <div className="flex w-full gap-1.5">
          <Select value={selectedOptionKey ?? undefined} onValueChange={handleSelectAirframeOption}>
            <SelectTrigger className="flex-1">
              <SelectValue
                placeholder={
                  loadingAirframeOptions
                    ? 'Loading…'
                    : typeTooShort
                      ? 'Enter an ICAO type above first'
                      : displayedOptions.length === 0
                        ? 'SimBrief doesn’t recognise this type'
                        : '— choose —'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {displayedOptions.map((o, i) => (
                <SelectItem key={i} value={String(i)}>
                  {optionLabel(o)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="text"
            value={form.simbriefType}
            onChange={(e) => handleManualSimbriefTypeChange(e.target.value)}
            placeholder="or type ICAO code"
            className="w-36"
          />
        </div>
        {selectedOption && !selectedOption.isDefault && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={handleCreateCustomAirframe}
            disabled={creatingAirframe}
          >
            {creatingAirframe ? 'Waiting for SimBrief…' : 'Create a custom airframe in SimBrief'}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          Live list from SimBrief's own community airframes for this type (MSFS only) — picking one fills the
          code alongside it, or creates a real saved profile in your SimBrief account. Used whenever no custom
          profile is set below.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Field
          label="Custom airframe profile"
          value={form.simbriefAirframeId}
          onChange={handleManualSimbriefAirframeIdChange}
        />
        {form.simbriefAirframeId.trim() !== '' && !/^\d+_\d+$/.test(form.simbriefAirframeId.trim()) && (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            Saved airframe IDs normally look like "123456_1582090020" — double-check this against
            SimBrief's airframe editor (see the Fleet detail page for a direct link).
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => void window.flightdeck.dispatchOpenSimBriefAirframes(form.simbriefAirframeId.trim() || null)}
        >
          Open airframes page
        </Button>
        <p className="text-xs text-muted-foreground">
          Leave blank to use the profile above. Already made one yourself in SimBrief? Open the airframes page
          to find its id.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Current airport</Label>
        <AirportSearch value={form.currentIcao} onChange={(v) => set('currentIcao', v)} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="outline" onClick={props.onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
