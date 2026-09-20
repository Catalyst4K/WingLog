import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Flight } from '@shared/ipc'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  countSetOptions,
  defaultDispatchOptions,
  dispatchOptionsFromApiParams,
  type DispatchOptions,
  type OptionValue
} from '@shared/dispatch-options'

/** Bound to a plain text Input: blank means unset (don't send this parameter at all —
 *  SimBrief's own default applies), and typing the literal word "auto" sends SimBrief's
 *  own "auto" value, which is a distinct, real option for several fields (pax, manual
 *  ZFW/payload, contingency %, reserve rule, cruise sub-mode) — see dispatch-options.ts. */
function OptionField(props: {
  label: string
  value: OptionValue
  onChange: (value: OptionValue) => void
  placeholder?: string
  autoEligible?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Label className="flex flex-col items-start gap-1.5">
      {props.label}
      <Input
        type="text"
        value={props.value ?? ''}
        placeholder={
          props.placeholder ??
          (props.autoEligible ? t('dispatchAdvancedDialog.blankOrAuto') : t('dispatchAdvancedDialog.blankDefault'))
        }
        onChange={(e) => {
          const raw = e.target.value
          props.onChange(raw === '' ? null : raw)
        }}
        onBlur={(e) => {
          const trimmed = e.target.value.trim()
          props.onChange(trimmed === '' ? null : trimmed)
        }}
      />
    </Label>
  )
}

export function DispatchAdvancedDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: DispatchOptions
  onOptionsChange: (options: DispatchOptions) => void
  /** Recent flights with a stored OFP — source list for "Load settings from…". */
  flights: Flight[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null)
  const set = <K extends keyof DispatchOptions>(key: K, value: OptionValue): void =>
    props.onOptionsChange({ ...props.options, [key]: value })

  function handleLoadFrom(flightId: string): void {
    const flight = props.flights.find((f) => String(f.id) === flightId)
    // Unreachable through the UI: the Select's own items are built from `loadable` (this
    // same `flights` list already filtered to a truthy ofpJson), so a value it hands back
    // always resolves to a flight that passes this guard. Kept as a defensive fallback
    // rather than a non-null assertion, in case that invariant ever changes.
    /* v8 ignore next */
    if (!flight?.ofpJson) return
    const loaded = dispatchOptionsFromApiParams(flight.ofpJson)
    if (!loaded) {
      setLoadedFrom(null)
      return
    }
    props.onOptionsChange(loaded)
    setLoadedFrom(flight.flightNumber ?? `${flight.depIcao} → ${flight.arrIcao}`)
  }

  const loadable = props.flights.filter((f) => f.ofpJson)

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('dispatchAdvancedDialog.title')}</DialogTitle>
          <DialogDescription>{t('dispatchAdvancedDialog.description')}</DialogDescription>
        </DialogHeader>

        {loadable.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label>{t('dispatchAdvancedDialog.loadFromPreviousFlight')}</Label>
            <Select onValueChange={handleLoadFrom}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t('dispatchAdvancedDialog.selectPastFlight')} />
              </SelectTrigger>
              <SelectContent>
                {loadable.map((f) => (
                  <SelectItem key={f.id} value={String(f.id)}>
                    {f.flightNumber ?? `${f.depIcao} → ${f.arrIcao}`}
                    {f.createdAt ? ` (${f.createdAt.slice(0, 10)})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loadedFrom && (
              <p className="text-xs text-muted-foreground">
                {t('dispatchAdvancedDialog.loadedFrom', { loadedFrom })}
              </p>
            )}
          </div>
        )}

        <Tabs defaultValue="load">
          <TabsList>
            <TabsTrigger value="load">{t('dispatchAdvancedDialog.tabs.load')}</TabsTrigger>
            <TabsTrigger value="fuel">{t('dispatchAdvancedDialog.tabs.fuel')}</TabsTrigger>
            <TabsTrigger value="cruise">{t('dispatchAdvancedDialog.tabs.cruise')}</TabsTrigger>
            <TabsTrigger value="route">{t('dispatchAdvancedDialog.tabs.route')}</TabsTrigger>
          </TabsList>
          <TabsContent value="load" className="grid grid-cols-2 gap-3">
            <OptionField
              label={t('dispatchAdvancedDialog.fields.passengers')}
              value={props.options.pax}
              onChange={(v) => set('pax', v)}
              autoEligible
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.cargo')}
              value={props.options.cargo}
              onChange={(v) => set('cargo', v)}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.manualZfw')}
              value={props.options.manualzfw}
              onChange={(v) => set('manualzfw', v)}
              autoEligible
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.manualPayload')}
              value={props.options.manualpayload}
              onChange={(v) => set('manualpayload', v)}
              autoEligible
            />
          </TabsContent>
          <TabsContent value="fuel" className="grid grid-cols-2 gap-3">
            <OptionField
              label={t('dispatchAdvancedDialog.fields.fuelFactor')}
              value={props.options.fuelfactor}
              onChange={(v) => set('fuelfactor', v)}
              placeholder={t('dispatchAdvancedDialog.placeholders.fuelFactor')}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.extraFuel')}
              value={props.options.addedfuel}
              onChange={(v) => set('addedfuel', v)}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.contingencyPct')}
              value={props.options.contpct}
              onChange={(v) => set('contpct', v)}
              autoEligible
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.reserveRule')}
              value={props.options.resvrule}
              onChange={(v) => set('resvrule', v)}
              autoEligible
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.taxiOut')}
              value={props.options.taxiout}
              onChange={(v) => set('taxiout', v)}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.taxiIn')}
              value={props.options.taxiin}
              onChange={(v) => set('taxiin', v)}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.tankering')}
              value={props.options.tankering}
              onChange={(v) => set('tankering', v)}
            />
          </TabsContent>
          <TabsContent value="cruise" className="grid grid-cols-2 gap-3">
            <OptionField
              label={t('dispatchAdvancedDialog.fields.costIndex')}
              value={props.options.civalue}
              onChange={(v) => set('civalue', v)}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.cruiseMode')}
              value={props.options.cruisemode}
              onChange={(v) => set('cruisemode', v)}
              placeholder={t('dispatchAdvancedDialog.placeholders.cruiseMode')}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.cruiseSubMode')}
              value={props.options.cruisesub}
              onChange={(v) => set('cruisesub', v)}
              autoEligible
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.flightLevel')}
              value={props.options.fl}
              onChange={(v) => set('fl', v)}
              placeholder={t('dispatchAdvancedDialog.placeholders.flightLevel')}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.climbProfile')}
              value={props.options.climb}
              onChange={(v) => set('climb', v)}
              placeholder={t('dispatchAdvancedDialog.placeholders.climbProfile')}
            />
            <OptionField
              label={t('dispatchAdvancedDialog.fields.descentProfile')}
              value={props.options.descent}
              onChange={(v) => set('descent', v)}
              placeholder={t('dispatchAdvancedDialog.placeholders.descentProfile')}
            />
          </TabsContent>
          <TabsContent value="route" className="flex flex-col gap-3">
            <OptionField
              label={t('dispatchAdvancedDialog.fields.routeOverride')}
              value={props.options.route}
              onChange={(v) => set('route', v)}
              placeholder={t('dispatchAdvancedDialog.placeholders.routeOverride')}
            />
            <div className="grid grid-cols-2 gap-3">
              <OptionField
                label={t('dispatchAdvancedDialog.fields.departureRunway')}
                value={props.options.origrwy}
                onChange={(v) => set('origrwy', v)}
              />
              <OptionField
                label={t('dispatchAdvancedDialog.fields.arrivalRunway')}
                value={props.options.destrwy}
                onChange={(v) => set('destrwy', v)}
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="items-center sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              props.onOptionsChange(defaultDispatchOptions())
              setLoadedFrom(null)
            }}
          >
            {t('dispatchAdvancedDialog.resetToDefaults')}
          </Button>
          <Button type="button" size="sm" onClick={() => props.onOpenChange(false)}>
            {t('dispatchAdvancedDialog.done', { count: countSetOptions(props.options) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
