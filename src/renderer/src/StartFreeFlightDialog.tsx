/** The "Start a free flight" dialog. */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { Aircraft, AircraftTypeOption, FreeFlightPrefill, SimTelemetry } from '@shared/ipc'
import { isRetired } from '@shared/aircraft'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AirportSearch } from './AirportSearch'
import { Combobox } from './components/Combobox'
import { asyncHandler } from './report-error'

/** Select's own value type is always a string — this sentinel picks "don't add to fleet"
 *  out of the list of real aircraft ids. Fleet creation no longer happens inline here at
 *  all (Callum's call: it's friction for something that should be purely optional, and
 *  belongs in Logbook after a flight is tracked, once there's a real flight to attach it
 *  to — see LogbookView's AddFlightToFleetDialog). Not adding to the fleet is the default
 *  whenever there's no remembered title match; the registration/type are still captured
 *  (and still auto-filled from the sim) on the flight row itself
 *  (Flight.simRegistration/simIcaoType) either way. */
const NO_AIRCRAFT = '__none__'

interface FormState {
  registration: string
  icaoType: string
  depIcao: string
  arrIcao: string
  flightNumber: string
}

const EMPTY_FORM: FormState = { registration: '', icaoType: '', depIcao: '', arrIcao: '', flightNumber: '' }

/** Set when a remembered title match's own on-file registration disagrees with what the sim
 *  currently reports — Callum's call: registration can't be trusted as an identifier (he
 *  doesn't necessarily change it per aircraft), but it's still worth surfacing as a
 *  non-blocking cross-check once title-memory has already picked an aircraft. */
interface RegistrationMismatch {
  aircraftId: number
  onFile: string
}

/**
 * Who is flying: a fleet aircraft, or — when tracking with none — the registration and type
 * typed in (kept on the flight row itself).
 *
 * @param addingNone True when "None" is selected.
 * @param form The form.
 * @param selectedExisting The chosen fleet aircraft, if any.
 * @returns The identity fields for trackingStartFree, or the translation key of what's missing.
 */
function flightIdentity(
  addingNone: boolean,
  form: FormState,
  selectedExisting: Aircraft | undefined
):
  | { aircraftId: number | null; simRegistration: string | null; simIcaoType: string | null }
  | { errorKey: string } {
  if (addingNone) {
    if (!form.registration.trim() || !form.icaoType.trim()) {
      return { errorKey: 'startFreeFlightDialog.enterRegistrationAndType' }
    }
    return {
      aircraftId: null,
      simRegistration: form.registration.trim(),
      simIcaoType: form.icaoType.trim().toUpperCase()
    }
  }
  if (!selectedExisting) return { errorKey: 'startFreeFlightDialog.chooseAnAircraft' }
  return { aircraftId: selectedExisting.id, simRegistration: null, simIcaoType: null }
}

/**
 * What the sim's prefill sets in the dialog.
 *
 * Aircraft resolution is title-memory only — Callum's call: registration isn't a reliable
 * identifier (he doesn't necessarily change it per aircraft), so it's never used to auto-select
 * a fleet row, only as the non-blocking cross-check above. The aircraft list is already loaded
 * by TrackView, so the lookup needs no extra IPC.
 *
 * @param prefill The main process's answer for the sim's current aircraft.
 * @param aircraft The fleet.
 * @returns The selected aircraft, the form, the ambiguity flag and the registration cross-check.
 */
function applyPrefill(
  prefill: FreeFlightPrefill,
  aircraft: Aircraft[]
): {
  selectedAircraftId: string
  form: FormState
  icaoTypeAmbiguous: boolean
  registrationMismatch: RegistrationMismatch | null
} {
  const remembered =
    prefill.rememberedAircraftId != null
      ? aircraft.find((a) => a.id === prefill.rememberedAircraftId && !isRetired(a))
      : undefined
  return {
    selectedAircraftId: remembered ? String(remembered.id) : NO_AIRCRAFT,
    form: {
      registration: prefill.registration,
      icaoType: prefill.icaoType ?? '',
      depIcao: prefill.suggestedDepIcao ?? '',
      arrIcao: '',
      flightNumber: ''
    },
    icaoTypeAmbiguous: prefill.icaoTypeAmbiguous,
    registrationMismatch:
      remembered && remembered.registration.toUpperCase() !== prefill.registration.toUpperCase()
        ? { aircraftId: remembered.id, onFile: remembered.registration }
        : null
  }
}

/**
 * The dialog's fields: aircraft and callsign, the registration cross-check, the type and
 * registration (only with no fleet aircraft), and the airports.
 *
 * @param props The form and the choices around it, and their setters.
 * @returns The element.
 */
function FreeFlightFields(props: {
  form: FormState
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void
  aircraft: Aircraft[]
  selectedAircraftId: string
  onSelectAircraft: (id: string) => void
  registrationMismatch: RegistrationMismatch | null
  icaoTypeAmbiguous: boolean
  onTypeEdited: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { form, set, selectedAircraftId, registrationMismatch, icaoTypeAmbiguous } = props
  // Registration/type are only ever editable when tracking with no linked fleet aircraft —
  // fleet creation no longer happens inline here at all, so there is no other branch that needs them.
  const showIdentityFields = selectedAircraftId === NO_AIRCRAFT
  const nonRetiredAircraft = props.aircraft.filter((a) => !isRetired(a))
  return (
    <div className="flex flex-col gap-3">
      {/* Fleet creation doesn't happen here — "None" tracks the flight with the sim's own
       *  registration/type, and Logbook's "Add to fleet" is there afterwards if it's
       *  worth keeping. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>{t('startFreeFlightDialog.aircraft')}</Label>
          <Select value={selectedAircraftId} onValueChange={props.onSelectAircraft}>
            <SelectTrigger className="w-full" aria-label={t('startFreeFlightDialog.aircraft')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_AIRCRAFT}>{t('startFreeFlightDialog.none')}</SelectItem>
              {nonRetiredAircraft.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.registration} — {a.icaoType}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Label className="flex flex-col items-start gap-1.5">
          {t('startFreeFlightDialog.callsign')}
          <Input
            type="text"
            value={form.flightNumber}
            onChange={(e) => set('flightNumber', e.target.value)}
            placeholder={t('startFreeFlightDialog.optional')}
          />
        </Label>
      </div>
      {registrationMismatch && String(registrationMismatch.aircraftId) === selectedAircraftId && (
        <span className="text-xs text-amber-600 dark:text-amber-500">
          {t('startFreeFlightDialog.registrationMismatch', {
            onFile: registrationMismatch.onFile,
            reported: form.registration || t('startFreeFlightDialog.nothing')
          })}
        </span>
      )}

      {showIdentityFields ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{t('startFreeFlightDialog.type')}</Label>
            <Combobox
              value={form.icaoType}
              onChange={(value) => {
                set('icaoType', value.toUpperCase())
                props.onTypeEdited()
              }}
              search={(query) => window.winglog.aircraftTypeSearch(query)}
              getOptionKey={(r: AircraftTypeOption) => `${r.icaoType}-${r.manufacturer}-${r.model}`}
              getOptionValue={(r) => r.icaoType}
              getOptionLabel={(r) => `${r.manufacturer} — ${r.model} (${r.icaoType})`}
              placeholder={t('startFreeFlightDialog.typePlaceholder')}
            />
          </div>
          <Label className="flex flex-col items-start gap-1.5">
            {t('startFreeFlightDialog.registration')}
            <Input
              type="text"
              value={form.registration}
              onChange={(e) => set('registration', e.target.value)}
            />
          </Label>
          {icaoTypeAmbiguous && (
            <span className="col-span-2 text-xs text-amber-600 dark:text-amber-500">
              {t('startFreeFlightDialog.typeAmbiguous')}
            </span>
          )}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>{t('startFreeFlightDialog.departure')}</Label>
          <AirportSearch value={form.depIcao} onChange={(v) => set('depIcao', v)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('startFreeFlightDialog.destination')}</Label>
          <AirportSearch
            value={form.arrIcao}
            onChange={(v) => set('arrIcao', v)}
            placeholder={t('startFreeFlightDialog.filledInOnLanding')}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * "Start a free flight" — free-flight-tracking.md's confirmation dialog. Everything is
 * prefilled from the sim (one trackingGetFreeFlightPrefill call, fired once when the dialog
 * opens) and everything stays editable, per the plan's own field table. Controlled rather
 * than owning its own trigger, since two different UI entry points (TrackView's Free flight
 * card and its passive detection banner) both open the same dialog instance.
 *
 * @param props Whether it's open, the sim's aircraft identity, the fleet, and the start handler.
 * @returns The element.
 */
export function StartFreeFlightDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  telemetry: SimTelemetry | null
  aircraft: Aircraft[]
  onStarted: (flightId: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Seeded from `open`/`telemetry` at construction time too, not just the render-phase
  // adjustment below — a dialog that happens to mount already open (this component makes
  // no assumption it's always mounted closed, even though TrackView's own usage today
  // always does) must show the right state on its very first render, not just from the
  // second render onward.
  const [loading, setLoading] = useState(props.open && !!props.telemetry)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(
    props.open && !props.telemetry ? t('startFreeFlightDialog.notConnected') : null
  )
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [selectedAircraftId, setSelectedAircraftId] = useState<string>(NO_AIRCRAFT)
  const [icaoTypeAmbiguous, setIcaoTypeAmbiguous] = useState(false)
  // Cleared whenever the pilot picks a different aircraft than the one this hint is about.
  const [registrationMismatch, setRegistrationMismatch] = useState<RegistrationMismatch | null>(null)

  // Resets the form the moment the dialog opens — adjusted during render (React's own
  // documented pattern for state depending on another value changing, same as
  // AircraftForm.tsx's own committedIcaoTypeForOptions) rather than in the effect below, so
  // the effect itself never calls setState synchronously, only from its async callbacks.
  const [prevOpen, setPrevOpen] = useState(props.open)
  if (props.open !== prevOpen) {
    setPrevOpen(props.open)
    if (props.open) {
      setForm(EMPTY_FORM)
      setSelectedAircraftId(NO_AIRCRAFT)
      setIcaoTypeAmbiguous(false)
      setRegistrationMismatch(null)
      setError(props.telemetry ? null : t('startFreeFlightDialog.notConnected'))
      setLoading(!!props.telemetry)
    }
  }

  // Resolved once per dialog open, not on every telemetry tick while it's open — the pilot
  // is editing a snapshot, not watching it drift under their cursor. Deliberately keyed only
  // on `open`; `props.telemetry` is read from the closure at the moment this fires.
  useEffect(() => {
    if (!props.open || !props.telemetry) return
    const telemetry = props.telemetry
    window.winglog
      .trackingGetFreeFlightPrefill({
        atcId: telemetry.atcId,
        atcModel: telemetry.atcModel,
        title: telemetry.title,
        latitude: telemetry.latitude,
        longitude: telemetry.longitude
      })
      .then((prefill) => {
        const applied = applyPrefill(prefill, props.aircraft)
        setSelectedAircraftId(applied.selectedAircraftId)
        setForm(applied.form)
        setIcaoTypeAmbiguous(applied.icaoTypeAmbiguous)
        setRegistrationMismatch(applied.registrationMismatch)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefilled once as the dialog opens, not on every telemetry tick
  }, [props.open])

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const addingNone = selectedAircraftId === NO_AIRCRAFT
  const selectedExisting = addingNone
    ? undefined
    : props.aircraft.find((a) => String(a.id) === selectedAircraftId)

  /**
   * Creates the free flight from the form, using an existing aircraft or a new one, and starts tracking
   * it. A failure is shown in the dialog.
   */
  async function handleSubmit(): Promise<void> {
    if (!props.telemetry) return
    setSubmitting(true)
    setError(null)
    try {
      const identity = flightIdentity(addingNone, form, selectedExisting)
      if ('errorKey' in identity) throw new Error(t(identity.errorKey))

      const flightId = await window.winglog.trackingStartFree({
        ...identity,
        depIcao: form.depIcao.trim() || null,
        arrIcao: form.arrIcao.trim() || null,
        flightNumber: form.flightNumber.trim() || null
      })
      props.onStarted(flightId)
      props.onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('startFreeFlightDialog.title')}</DialogTitle>
          {/* The add-on's own display string, verbatim — what most add-ons' own EFB panels
           *  recognise the aircraft by (unlike atcModel's localisation-token mess that
           *  parseAircraftIdentity has to unwrap for the Type field). Informational only. */}
          <DialogDescription>
            {props.telemetry?.title || t('startFreeFlightDialog.trackingStartsFromNow')}
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('startFreeFlightDialog.readingTheSim')}</p>
        ) : (
          <FreeFlightFields
            form={form}
            set={set}
            aircraft={props.aircraft}
            selectedAircraftId={selectedAircraftId}
            onSelectAircraft={setSelectedAircraftId}
            registrationMismatch={registrationMismatch}
            icaoTypeAmbiguous={icaoTypeAmbiguous}
            onTypeEdited={() => setIcaoTypeAmbiguous(false)}
          />
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t('startFreeFlightDialog.cancel')}
          </Button>
          <Button
            type="button"
            onClick={asyncHandler('StartFreeFlightDialog handleSubmit', handleSubmit)}
            disabled={loading || submitting || !props.telemetry}
          >
            {submitting ? t('startFreeFlightDialog.starting') : t('startFreeFlightDialog.startTracking')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
