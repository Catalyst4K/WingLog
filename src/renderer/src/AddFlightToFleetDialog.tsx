import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { Aircraft, AircraftTypeOption, Flight } from '@shared/ipc'
import { isRetired } from '@shared/aircraft'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Combobox } from './components/Combobox'

const EXISTING = '__existing__'

/**
 * Logbook's "Add to fleet" — the free-flight-tracking.md fleet-creation flow relocated here
 * from the start dialog (Callum's call: deciding whether an aircraft is worth keeping in the
 * fleet shouldn't be friction at flight-start time; it belongs after there's a real flight to
 * look at). Only ever shown for a completed free flight with no linked aircraft
 * (`flight.aircraftId == null`) — its `simRegistration`/`simIcaoType` are what a fleet
 * aircraft record would otherwise have supplied, so they prefill this form the same way the
 * start dialog used to.
 *
 * Two modes: create a new fleet aircraft from the sim-reported identity (editable), or link
 * this flight to one already in the fleet — covers both "this was genuinely a new aircraft"
 * and "I forgot to pick it at flight-start, but it's actually my G-EUYY".
 */
export function AddFlightToFleetDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flight: Flight
  fleetAircraft: Aircraft[]
  onLinked: (flight: Flight) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const nonRetiredAircraft = props.fleetAircraft.filter((a) => !isRetired(a))
  const [selected, setSelected] = useState<string>(nonRetiredAircraft.length > 0 ? EXISTING : 'new')
  const [registration, setRegistration] = useState(props.flight.simRegistration ?? '')
  const [icaoType, setIcaoType] = useState(props.flight.simIcaoType ?? '')
  const [existingId, setExistingId] = useState<string>(String(nonRetiredAircraft[0]?.id ?? ''))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const creatingNew = selected === 'new'

  async function handleSubmit(): Promise<void> {
    setSubmitting(true)
    setError(null)
    try {
      let aircraftId: number
      if (creatingNew) {
        if (!registration.trim() || !icaoType.trim()) {
          throw new Error(t('addFlightToFleetDialog.enterRegistrationAndType'))
        }
        const created = await window.winglog.aircraftCreate({
          registration: registration.trim(),
          icaoType: icaoType.trim().toUpperCase()
        })
        aircraftId = created.id
      } else {
        if (!existingId) throw new Error(t('addFlightToFleetDialog.chooseAnAircraft'))
        aircraftId = Number(existingId)
      }
      const updated = await window.winglog.flightLinkAircraft(props.flight.id, aircraftId)
      props.onLinked(updated)
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('addFlightToFleetDialog.title')}</DialogTitle>
          <DialogDescription>{t('addFlightToFleetDialog.description')}</DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-col gap-4">
          {nonRetiredAircraft.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label>{t('addFlightToFleetDialog.aircraft')}</Label>
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EXISTING}>{t('addFlightToFleetDialog.linkToExisting')}</SelectItem>
                  <SelectItem value="new">{t('addFlightToFleetDialog.addAsNew')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {creatingNew ? (
            <>
              <Label className="flex flex-col items-start gap-1.5">
                {t('addFlightToFleetDialog.registration')}
                <Input type="text" value={registration} onChange={(e) => setRegistration(e.target.value)} />
              </Label>
              <div className="flex flex-col gap-1.5">
                <Label>{t('addFlightToFleetDialog.type')}</Label>
                <Combobox
                  value={icaoType}
                  onChange={(value) => setIcaoType(value.toUpperCase())}
                  search={(query) => window.winglog.aircraftTypeSearch(query)}
                  getOptionKey={(r: AircraftTypeOption) => `${r.icaoType}-${r.manufacturer}-${r.model}`}
                  getOptionValue={(r) => r.icaoType}
                  getOptionLabel={(r) => `${r.manufacturer} — ${r.model} (${r.icaoType})`}
                  placeholder={t('addFlightToFleetDialog.typePlaceholder')}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label>{t('addFlightToFleetDialog.existingAircraft')}</Label>
              <Select value={existingId} onValueChange={setExistingId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {nonRetiredAircraft.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.registration} — {a.icaoType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t('addFlightToFleetDialog.cancel')}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={submitting}>
            {submitting ? t('addFlightToFleetDialog.adding') : t('addFlightToFleetDialog.addToFleet')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
