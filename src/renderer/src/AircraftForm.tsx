import { useState } from 'react'
import type { Aircraft, AircraftTypeOption, AirlineOption, NewAircraft } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  const str = (s: string): string | undefined => (s.trim() === '' ? undefined : s.trim())

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
  // Not a visible form field — the user never types a photo URL, it only ever comes from
  // a registration lookup (docs/plans/fleet-redesign.md #3). Kept out of FormState so
  // toFormState/toNewAircraft don't need to round-trip a value nothing renders as input.
  const [photoThumbnailUrl, setPhotoThumbnailUrl] = useState<string | null>(props.initial?.photoThumbnailUrl ?? null)

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
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
      await props.onSubmit({ ...toNewAircraft(form), photoThumbnailUrl })
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
        <Field
          label="SimBrief profile"
          value={form.simbriefAirframeId}
          onChange={(v) => set('simbriefAirframeId', v)}
        />
        {form.simbriefAirframeId.trim() !== '' && !/^\d+_\d+$/.test(form.simbriefAirframeId.trim()) && (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            Saved airframe IDs normally look like "123456_1582090020" — double-check this against
            SimBrief's airframe editor (see the Fleet detail page for a direct link).
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Leave blank to use SimBrief's own default airframe — optionally naming one below.
        </p>
      </div>
      <Field
        label="SimBrief default type (if no custom profile)"
        value={form.simbriefType}
        onChange={(v) => set('simbriefType', v.toUpperCase())}
      />

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
