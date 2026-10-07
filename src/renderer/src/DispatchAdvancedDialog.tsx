/** Dispatch's Advanced dialog: SimBrief's optional planning parameters. */

import { winglogApi } from './data/winglog-api'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LogbookFlight } from '@shared/ipc'
import { asyncHandler } from './report-error'
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

/**
 * Bound to a plain text Input: blank means unset (don't send this parameter at all —
 * SimBrief's own default applies), and typing the literal word "auto" sends SimBrief's
 * own "auto" value, which is a distinct, real option for several fields (pax, manual
 * ZFW/payload, contingency %, reserve rule, cruise sub-mode) — see dispatch-options.ts.
 *
 * @param props The field's label, value and change handler.
 * @returns The element.
 */
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
          (props.autoEligible
            ? t('dispatchAdvancedDialog.blankOrAuto')
            : t('dispatchAdvancedDialog.blankDefault'))
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

/**
 * The Advanced dialog: SimBrief's optional parameters, grouped, each blank for SimBrief's default.
 *
 * @param props The current options and the handler that applies new ones.
 * @returns The element.
 */
export function DispatchAdvancedDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: DispatchOptions
  onOptionsChange: (options: DispatchOptions) => void
  /** Recent flights with a stored OFP — source list for "Load settings from…". */
  flights: LogbookFlight[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null)
  const set = <K extends keyof DispatchOptions>(key: K, value: OptionValue): void =>
    props.onOptionsChange({ ...props.options, [key]: value })

  async function handleLoadFrom(flightId: string): Promise<void> {
    const listed = props.flights.find((f) => String(f.id) === flightId)
    // Unreachable through the UI: the Select's items are built from `loadable` (this same list, filtered to flights with an
    // OFP), so a value it hands back always resolves. Kept as a defensive fallback rather than a non-null assertion.
    /* v8 ignore next */
    if (!listed) return
    // The list leaves OFPs out (they are about 1 MB each); only the chosen flight's is fetched.
    const ofpJson = (await winglogApi().logbookGetFlight(listed.id))?.ofpJson
    const loaded = ofpJson ? dispatchOptionsFromApiParams(ofpJson) : null
    if (!loaded) {
      setLoadedFrom(null)
      return
    }
    props.onOptionsChange(loaded)
    setLoadedFrom(listed.flightNumber ?? `${listed.depIcao} → ${listed.arrIcao}`)
  }

  const loadable = props.flights.filter((f) => f.hasOfp)

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
            <Select onValueChange={asyncHandler('DispatchAdvancedDialog handleLoadFrom', handleLoadFrom)}>
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
