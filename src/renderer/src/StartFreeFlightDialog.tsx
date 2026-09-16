import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { Aircraft, AircraftTypeOption, SimTelemetry } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AirportSearch } from './AirportSearch'
import { Combobox } from './components/Combobox'

/** Select's own value type is always a string — this sentinel picks "create a new fleet
 *  aircraft" out of the list of real aircraft ids (free-flight-tracking.md's aircraft-
 *  resolution step 3, "Add <reg> (<type>) to fleet"). */
const NEW_AIRCRAFT = '__new__'

interface FormState {
  registration: string
  icaoType: string
  depIcao: string
  arrIcao: string
  flightNumber: string
}

const EMPTY_FORM: FormState = { registration: '', icaoType: '', depIcao: '', arrIcao: '', flightNumber: '' }

/**
 * "Start a free flight" — free-flight-tracking.md's confirmation dialog. Everything is
 * prefilled from the sim (one trackingGetFreeFlightPrefill call, fired once when the dialog
 * opens) and everything stays editable, per the plan's own field table. Controlled rather
 * than owning its own trigger, since two different UI entry points (TrackView's Free flight
 * card and its passive detection banner) both open the same dialog instance.
 */
export function StartFreeFlightDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  telemetry: SimTelemetry | null
  aircraft: Aircraft[]
  onStarted: (flightId: number) => void
}): React.JSX.Element {
  // Seeded from `open`/`telemetry` at construction time too, not just the render-phase
  // adjustment below — a dialog that happens to mount already open (this component makes
  // no assumption it's always mounted closed, even though TrackView's own usage today
  // always does) must show the right state on its very first render, not just from the
  // second render onward.
  const [loading, setLoading] = useState(props.open && !!props.telemetry)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(props.open && !props.telemetry ? 'Not connected to the sim.' : null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [selectedAircraftId, setSelectedAircraftId] = useState<string>(NEW_AIRCRAFT)
  const [icaoTypeAmbiguous, setIcaoTypeAmbiguous] = useState(false)

  // Resets the form the moment the dialog opens — adjusted during render (React's own
  // documented pattern for state depending on another value changing, same as
  // AircraftForm.tsx's own committedIcaoTypeForOptions) rather than in the effect below, so
  // the effect itself never calls setState synchronously, only from its async callbacks.
  const [prevOpen, setPrevOpen] = useState(props.open)
  if (props.open !== prevOpen) {
    setPrevOpen(props.open)
    if (props.open) {
      setForm(EMPTY_FORM)
      setSelectedAircraftId(NEW_AIRCRAFT)
      setIcaoTypeAmbiguous(false)
      setError(props.telemetry ? null : 'Not connected to the sim.')
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
        // Step 1 (fleet match on atcId) happens here, client-side — the aircraft list is
        // already loaded by TrackView, no IPC needed for it. Step 2 (title memory) came
        // back from the prefill call itself. Free-flight-tracking.md's resolution order.
        const fleetMatch = props.aircraft.find(
          (a) => a.replacedByAircraftId === null && a.registration.toUpperCase() === prefill.registration.toUpperCase()
        )
        const remembered =
          prefill.rememberedAircraftId != null
            ? props.aircraft.find((a) => a.id === prefill.rememberedAircraftId && a.replacedByAircraftId === null)
            : undefined
        const matched = fleetMatch ?? remembered
        setSelectedAircraftId(matched ? String(matched.id) : NEW_AIRCRAFT)
        setForm({
          registration: prefill.registration,
          icaoType: prefill.icaoType ?? '',
          depIcao: prefill.suggestedDepIcao ?? '',
          arrIcao: '',
          flightNumber: ''
        })
        setIcaoTypeAmbiguous(prefill.icaoTypeAmbiguous)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const creatingNew = selectedAircraftId === NEW_AIRCRAFT
  const nonRetiredAircraft = props.aircraft.filter((a) => a.replacedByAircraftId === null)
  const selectedExisting = creatingNew ? undefined : props.aircraft.find((a) => String(a.id) === selectedAircraftId)

  async function handleSubmit(): Promise<void> {
    if (!props.telemetry) return
    setSubmitting(true)
    setError(null)
    try {
      let aircraftId: number
      if (creatingNew) {
        if (!form.registration.trim() || !form.icaoType.trim()) {
          throw new Error('Enter a registration and type for the new aircraft.')
        }
        const created = await window.winglog.aircraftCreate({
          registration: form.registration.trim(),
          icaoType: form.icaoType.trim().toUpperCase()
        })
        aircraftId = created.id
      } else if (selectedExisting) {
        aircraftId = selectedExisting.id
      } else {
        throw new Error('Choose an aircraft.')
      }

      const flightId = await window.winglog.trackingStartFree({
        aircraftId,
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
          <DialogTitle>Start a free flight</DialogTitle>
          <DialogDescription>
            Tracking begins immediately from wherever the aircraft is right now — no SimBrief plan needed.
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {loading ? (
          <p className="text-sm text-muted-foreground">Reading the sim…</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Aircraft</Label>
              <Select value={selectedAircraftId} onValueChange={setSelectedAircraftId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW_AIRCRAFT}>
                    Add {form.registration || 'new aircraft'} {form.icaoType ? `(${form.icaoType})` : ''} to fleet
                  </SelectItem>
                  {nonRetiredAircraft.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.registration} — {a.icaoType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {creatingNew ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label className="flex flex-col items-start gap-1.5">
                    Registration
                    <Input
                      type="text"
                      value={form.registration}
                      onChange={(e) => set('registration', e.target.value)}
                    />
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    What MSFS's own aircraft-configuration page has set for this aircraft — matched to your fleet
                    automatically next time.
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Type</Label>
                  <Combobox
                    value={form.icaoType}
                    onChange={(value) => {
                      set('icaoType', value.toUpperCase())
                      setIcaoTypeAmbiguous(false)
                    }}
                    search={(query) => window.winglog.aircraftTypeSearch(query)}
                    getOptionKey={(r: AircraftTypeOption) => `${r.icaoType}-${r.manufacturer}-${r.model}`}
                    getOptionValue={(r) => r.icaoType}
                    getOptionLabel={(r) => `${r.manufacturer} — ${r.model} (${r.icaoType})`}
                    placeholder="e.g. A350, Boeing, B77W, or type an ICAO code"
                  />
                  {icaoTypeAmbiguous && (
                    <span className="text-xs text-amber-600 dark:text-amber-500">
                      Guessed from the sim — this add-on has more than one variant, double-check it.
                    </span>
                  )}
                </div>
              </>
            ) : null}

            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label>Departure</Label>
                <AirportSearch value={form.depIcao} onChange={(v) => set('depIcao', v)} />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label>Destination</Label>
                <AirportSearch
                  value={form.arrIcao}
                  onChange={(v) => set('arrIcao', v)}
                  placeholder="Leave blank — filled in on landing"
                />
              </div>
            </div>

            <Label className="flex flex-col items-start gap-1.5">
              Flight number
              <Input
                type="text"
                value={form.flightNumber}
                onChange={(e) => set('flightNumber', e.target.value)}
                placeholder="Optional"
              />
            </Label>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={loading || submitting || !props.telemetry}>
            {submitting ? 'Starting…' : 'Start tracking'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
