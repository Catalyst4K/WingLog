/** The Fleet aircraft form: identity, registration lookup, airline and SimBrief airframe. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Aircraft,
  AircraftTypeOption,
  AirlineOption,
  NewAircraft,
  SimbriefAirframeOption
} from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AirportSearch } from './AirportSearch'
import { Combobox } from './components/Combobox'
import { AirframeProfileField, CustomAirframeField } from './aircraft-form/AirframeFields'
import { fillFromLookup } from './aircraft-form/lookup-fill'
import { asyncHandler, runAsync } from './report-error'

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

/**
 * The values the form carries but has no input for: from the aircraft being edited, else none.
 *
 * @param a The aircraft being edited, if any.
 * @returns The photo and the SimBrief airframe's developer, engines and registration.
 */
function hiddenFields(a: Aircraft | undefined): {
  photoThumbnailUrl: string | null
  airframeDeveloper: string | null
  airframeEngines: string | null
  airframeRegistration: string | null
} {
  return {
    photoThumbnailUrl: a?.photoThumbnailUrl ?? null,
    airframeDeveloper: a?.simbriefAirframeDeveloper ?? null,
    airframeEngines: a?.simbriefAirframeEngines ?? null,
    airframeRegistration: a?.simbriefAirframeRegistration ?? null
  }
}

/**
 * Adds or edits a Fleet aircraft.
 *
 * @param props The aircraft being edited (or none for a new one), and the save and cancel handlers.
 * @returns The element.
 */
export function AircraftForm(props: {
  initial?: Aircraft
  onSubmit: (data: NewAircraft) => Promise<void>
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [form, setForm] = useState<FormState>(props.initial ? toFormState(props.initial) : EMPTY_FORM)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [lookupStatus, setLookupStatus] = useState<string | null>(null)
  const [lookingUp, setLookingUp] = useState(false)
  // Not visible form fields — the user never types these directly, they only ever come
  // from a registration lookup or the SimBrief airframe picker below (docs/plans/
  // fleet-redesign.md #3, docs/plans/simbrief-airframe-picker.md). Kept out of FormState
  // so toFormState/toNewAircraft don't need to round-trip values nothing renders as input.
  const hidden = hiddenFields(props.initial)
  const [photoThumbnailUrl, setPhotoThumbnailUrl] = useState<string | null>(hidden.photoThumbnailUrl)
  const [airframeDeveloper, setAirframeDeveloper] = useState<string | null>(hidden.airframeDeveloper)
  const [airframeEngines, setAirframeEngines] = useState<string | null>(hidden.airframeEngines)
  const [airframeRegistration, setAirframeRegistration] = useState<string | null>(hidden.airframeRegistration)

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
      runAsync(
        'AircraftForm simbriefAirframesForType',
        winglogApi()
          .simbriefAirframesForType(trimmedIcaoType)
          .then((options) => {
            if (!cancelled) setAirframeOptions(options)
          })
          .finally(() => {
            if (!cancelled) setLoadingAirframeOptions(false)
          })
      )
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmedIcaoType])

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  /**
   * The raw text fields stay directly editable (never blocked), but typing over a value
   * the picker set invalidates its cached label — showing a stale developer/engine
   * label next to a hand-edited id/type would be actively misleading.
   *
   * @param value The typed airframe id.
   */
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

  /**
   * Applies the SimBrief airframe the pilot picked from the list to the form's fields.
   *
   * @param key The index of the chosen option, as the select's value.
   */
  function handleSelectAirframeOption(key: string): void {
    setSelectedOptionKey(key)
    const option = displayedOptions[Number(key)]
    /* v8 ignore start -- defensive only: `key` is always one of displayedOptions' own
     * indices (Select only ever calls onValueChange with a value from its own rendered
     * SelectItems), so `option` is never actually undefined via any real interaction. */
    if (!option) return
    /* v8 ignore stop */
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
      const result = await winglogApi().simbriefCreateCustomAirframe(selectedOption.shareUrl)
      if (result) {
        set('simbriefAirframeId', result)
        setLookupStatus(t('aircraftForm.customAirframeSaved'))
      } else {
        setLookupStatus(t('aircraftForm.customAirframeNotSaved'))
      }
    } finally {
      setCreatingAirframe(false)
    }
  }

  /**
   * Looks the registration up online and fills the form with the match. Says so when there is no
   * registration or no match.
   */
  async function handleLookup(): Promise<void> {
    const registration = form.registration.trim()
    if (!registration) {
      setLookupStatus(t('aircraftForm.enterRegistrationFirst'))
      return
    }
    setLookingUp(true)
    setLookupStatus(null)
    try {
      const result = await winglogApi().aircraftLookupByRegistration(registration)
      if (!result) {
        setLookupStatus(t('aircraftForm.noMatch', { registration }))
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
        ? await winglogApi().airlineFindByIcao(result.operatorIcao)
        : undefined
      // Fills blanks only — never overwrites something already typed/edited.
      const hadSimbriefType = form.simbriefType.trim() !== ''
      setForm((current) => fillFromLookup(current, result, matchedAirline))
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
        runAsync(
          'AircraftForm simbriefAirframesForType',
          winglogApi().simbriefAirframesForType(result.icaoType).then((options) => {
            if (options.some((o) => o.isDefault)) {
              setForm((current) =>
                current.simbriefType.trim() !== '' ? current : { ...current, simbriefType: result.icaoType }
              )
            }
          })
        )
      }
      setLookupStatus(
        t('aircraftForm.found', {
          operator: result.operator ?? t('aircraftForm.unknownOperator'),
          icaoType: result.icaoType
        })
      )
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
    <form
      onSubmit={asyncHandler('AircraftForm handleSubmit', handleSubmit)}
      className="flex max-w-md flex-col gap-5"
    >
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Label className="flex flex-col items-start gap-1.5">
        {t('aircraftForm.registration')}
        <div className="flex w-full gap-1.5">
          <Input
            type="text"
            value={form.registration}
            required
            onChange={(e) => set('registration', e.target.value)}
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={asyncHandler('AircraftForm handleLookup', handleLookup)}
            disabled={lookingUp}
          >
            {lookingUp ? '…' : t('aircraftForm.lookUp')}
          </Button>
        </div>
      </Label>

      {lookupStatus && <p className="text-sm text-muted-foreground">{lookupStatus}</p>}

      <div className="flex flex-col gap-1.5">
        <Label>{t('aircraftForm.icaoType')}</Label>
        <Combobox
          value={form.icaoType}
          onChange={(value) => set('icaoType', value.toUpperCase())}
          search={(query) => winglogApi().aircraftTypeSearch(query)}
          getOptionKey={(r: AircraftTypeOption) => `${r.icaoType}-${r.manufacturer}-${r.model}`}
          getOptionValue={(r) => r.icaoType}
          getOptionLabel={(r) => `${r.manufacturer} — ${r.model} (${r.icaoType})`}
          placeholder={t('aircraftForm.icaoTypePlaceholder')}
        />
        <p className="text-xs text-muted-foreground">{t('aircraftForm.icaoTypeHint')}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>{t('aircraftForm.airline')}</Label>
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
          search={(query) => winglogApi().airlineSearch(query)}
          getOptionKey={(r: AirlineOption) => `${r.icao}-${r.name}`}
          getOptionValue={(r) => r.name}
          getOptionLabel={(r) => `${r.name} (${r.icao}${r.iata ? `/${r.iata}` : ''})`}
          placeholder={t('aircraftForm.airlinePlaceholder')}
        />
      </div>

      <AirframeProfileField
        options={displayedOptions}
        selectedOptionKey={selectedOptionKey}
        selectedOption={selectedOption}
        loading={loadingAirframeOptions}
        typeTooShort={typeTooShort}
        creatingAirframe={creatingAirframe}
        simbriefType={form.simbriefType}
        onSelectOption={handleSelectAirframeOption}
        onTypeChange={handleManualSimbriefTypeChange}
        onCreateCustomAirframe={handleCreateCustomAirframe}
      />

      <CustomAirframeField value={form.simbriefAirframeId} onChange={handleManualSimbriefAirframeIdChange} />

      <div className="flex flex-col gap-1.5">
        <Label>{t('aircraftForm.currentAirport')}</Label>
        <AirportSearch value={form.currentIcao} onChange={(v) => set('currentIcao', v)} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? t('aircraftForm.saving') : t('aircraftForm.save')}
        </Button>
        <Button type="button" variant="outline" onClick={props.onCancel} disabled={submitting}>
          {t('aircraftForm.cancel')}
        </Button>
      </div>
    </form>
  )
}
