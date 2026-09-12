import { useState } from 'react'
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
  return (
    <Label className="flex flex-col items-start gap-1.5">
      {props.label}
      <Input
        type="text"
        value={props.value ?? ''}
        placeholder={props.placeholder ?? (props.autoEligible ? 'blank = default, or "auto"' : 'blank = default')}
        onChange={(e) => {
          const raw = e.target.value.trim()
          props.onChange(raw === '' ? null : raw)
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
          <DialogTitle>Advanced dispatch options</DialogTitle>
          <DialogDescription>
            Every field is optional and blank by default — leaving all of them untouched produces the same
            SimBrief request as today.
          </DialogDescription>
        </DialogHeader>

        {loadable.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label>Load settings from a previous flight</Label>
            <Select onValueChange={handleLoadFrom}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="— select a past flight —" />
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
                Loaded from {loadedFrom} — departure date/time was not restored, since it's always the one
                thing worth setting fresh.
              </p>
            )}
          </div>
        )}

        <Tabs defaultValue="load">
          <TabsList>
            <TabsTrigger value="load">Load</TabsTrigger>
            <TabsTrigger value="fuel">Fuel</TabsTrigger>
            <TabsTrigger value="cruise">Cruise</TabsTrigger>
            <TabsTrigger value="route">Route</TabsTrigger>
          </TabsList>
          <TabsContent value="load" className="grid grid-cols-2 gap-3">
            <OptionField label="Passengers" value={props.options.pax} onChange={(v) => set('pax', v)} autoEligible />
            <OptionField label="Cargo (kg)" value={props.options.cargo} onChange={(v) => set('cargo', v)} />
            <OptionField
              label="Manual ZFW"
              value={props.options.manualzfw}
              onChange={(v) => set('manualzfw', v)}
              autoEligible
            />
            <OptionField
              label="Manual payload"
              value={props.options.manualpayload}
              onChange={(v) => set('manualpayload', v)}
              autoEligible
            />
          </TabsContent>
          <TabsContent value="fuel" className="grid grid-cols-2 gap-3">
            <OptionField
              label="Fuel factor"
              value={props.options.fuelfactor}
              onChange={(v) => set('fuelfactor', v)}
              placeholder="e.g. 1.0"
            />
            <OptionField label="Extra fuel (kg)" value={props.options.addedfuel} onChange={(v) => set('addedfuel', v)} />
            <OptionField
              label="Contingency %"
              value={props.options.contpct}
              onChange={(v) => set('contpct', v)}
              autoEligible
            />
            <OptionField
              label="Reserve rule"
              value={props.options.resvrule}
              onChange={(v) => set('resvrule', v)}
              autoEligible
            />
            <OptionField label="Taxi out (min)" value={props.options.taxiout} onChange={(v) => set('taxiout', v)} />
            <OptionField label="Taxi in (min)" value={props.options.taxiin} onChange={(v) => set('taxiin', v)} />
            <OptionField label="Tankering (kg)" value={props.options.tankering} onChange={(v) => set('tankering', v)} />
          </TabsContent>
          <TabsContent value="cruise" className="grid grid-cols-2 gap-3">
            <OptionField label="Cost index" value={props.options.civalue} onChange={(v) => set('civalue', v)} />
            <OptionField
              label="Cruise mode"
              value={props.options.cruisemode}
              onChange={(v) => set('cruisemode', v)}
              placeholder="e.g. CI, LRC, MMO"
            />
            <OptionField
              label="Cruise sub-mode"
              value={props.options.cruisesub}
              onChange={(v) => set('cruisesub', v)}
              autoEligible
            />
            <OptionField label="Flight level" value={props.options.fl} onChange={(v) => set('fl', v)} placeholder="e.g. 350" />
            <OptionField
              label="Climb profile"
              value={props.options.climb}
              onChange={(v) => set('climb', v)}
              placeholder="e.g. 250/320/84"
            />
            <OptionField
              label="Descent profile"
              value={props.options.descent}
              onChange={(v) => set('descent', v)}
              placeholder="e.g. 85/300/250"
            />
          </TabsContent>
          <TabsContent value="route" className="flex flex-col gap-3">
            <OptionField
              label="Route override"
              value={props.options.route}
              onChange={(v) => set('route', v)}
              placeholder="leave blank to let SimBrief plan it"
            />
            <div className="grid grid-cols-2 gap-3">
              <OptionField label="Departure runway" value={props.options.origrwy} onChange={(v) => set('origrwy', v)} />
              <OptionField label="Arrival runway" value={props.options.destrwy} onChange={(v) => set('destrwy', v)} />
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
            Reset to defaults
          </Button>
          <Button type="button" size="sm" onClick={() => props.onOpenChange(false)}>
            Done ({countSetOptions(props.options)} set)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
