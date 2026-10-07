/** The aircraft form's SimBrief fields: the airframe profile picker and the custom airframe id. */

import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { SimbriefAirframeOption } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { asyncHandler, runAsync } from '../report-error'

/**
 * A short label for one dropdown row — the stock entry gets a fixed label (nothing to
 * attribute it to), a community entry prefers its parsed developer, falling back to the
 * raw comment for the ~3% that don't match SimBrief's usual naming shape (docs/plans/
 * simbrief-airframe-picker.md). The type never appears here — options are fetched per
 * type, so it's identical on every row and can't help distinguish them (docs/plans/
 * simbrief-airframe-picker-v2.md, decision 1). `variant` is whatever the raw comment adds
 * beyond developer/engines (e.g. "(SL)" on an A320, a whole phrase like "Dual Class" on a
 * PMDG 737 — docs/simbrief-notes.md) — shown only when the parse actually found one.
 *
 * @param o The airframe option.
 * @param t The translation function.
 * @returns The label.
 */
function optionLabel(o: SimbriefAirframeOption, t: TFunction): string {
  if (o.isDefault) return t('aircraftForm.simbriefDefaultOption', { engines: o.engines })
  const variant = o.variant ? ` — ${o.variant}` : ''
  return `${o.developer ?? o.comments}${variant} — ${o.engines}`
}

/**
 * Same idea as optionLabel, but for the collapsed Select value and Fleet's read-only
 * display — contexts with no dropdown of sibling rows around them to establish the type
 * from, unlike optionLabel's own rows (decision 2, docs/plans/simbrief-airframe-
 * picker-v2.md). Skips appending the type onto the raw-comment fallback case (no
 * `developer`) — that text is already a full, self-contained description, not built to
 * have a type code glued onto the end of it.
 *
 * @param o The airframe option.
 * @param t The translation function.
 * @returns The label.
 */
function selectedOptionLabel(o: SimbriefAirframeOption, t: TFunction): string {
  if (o.isDefault)
    return t('aircraftForm.simbriefDefaultSelected', { simbriefType: o.simbriefType, engines: o.engines })
  if (!o.developer) return o.comments
  const variant = o.variant ? ` — ${o.variant}` : ''
  return `${o.developer} ${o.simbriefType}${variant} — ${o.engines}`
}

/**
 * What the profile dropdown shows while nothing is chosen.
 *
 * @param state Whether options are loading, whether the type is too short to look up, and how many options there are.
 * @param t The translation function.
 * @returns The placeholder text.
 */
function profilePlaceholder(
  state: { loading: boolean; typeTooShort: boolean; optionCount: number },
  t: TFunction
): string {
  if (state.loading) return t('aircraftForm.loading')
  if (state.typeTooShort) return t('aircraftForm.enterIcaoTypeFirst')
  if (state.optionCount === 0) return t('aircraftForm.simbriefUnrecognisedType')
  return t('aircraftForm.choose')
}

/**
 * The SimBrief airframe profile: a dropdown of the profiles SimBrief has for the type, a box
 * for typing the type code, and (for a community profile) the button that saves it as a custom
 * airframe.
 *
 * @param props The options, what's chosen, the typed type code, and the handlers.
 * @returns The element.
 */
export function AirframeProfileField(props: {
  options: SimbriefAirframeOption[]
  selectedOptionKey: string | null
  selectedOption: SimbriefAirframeOption | undefined
  loading: boolean
  typeTooShort: boolean
  creatingAirframe: boolean
  simbriefType: string
  onSelectOption: (key: string) => void
  onTypeChange: (value: string) => void
  onCreateCustomAirframe: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const { selectedOption } = props
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{t('aircraftForm.profile')}</Label>
      <div className="flex w-full gap-1.5">
        <Select value={props.selectedOptionKey ?? undefined} onValueChange={props.onSelectOption}>
          <SelectTrigger className="flex-1">
            <SelectValue
              placeholder={profilePlaceholder(
                {
                  loading: props.loading,
                  typeTooShort: props.typeTooShort,
                  optionCount: props.options.length
                },
                t
              )}
            >
              {selectedOption ? selectedOptionLabel(selectedOption, t) : undefined}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {props.options.map((o, i) => (
              <SelectItem key={i} value={String(i)}>
                {optionLabel(o, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="text"
          value={props.simbriefType}
          onChange={(e) => props.onTypeChange(e.target.value)}
          placeholder={t('aircraftForm.orTypeIcaoCode')}
          className="w-36"
        />
      </div>
      {selectedOption && !selectedOption.isDefault && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={asyncHandler('AircraftForm handleCreateCustomAirframe', props.onCreateCustomAirframe)}
          disabled={props.creatingAirframe}
        >
          {props.creatingAirframe
            ? t('aircraftForm.waitingForSimBrief')
            : t('aircraftForm.createCustomAirframe')}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{t('aircraftForm.profileHint')}</p>
    </div>
  )
}

/**
 * The custom airframe id box, a warning when it isn't in SimBrief's "number_number" shape, and
 * the button that opens SimBrief's airframes page.
 *
 * @param props The id and its change handler.
 * @returns The element.
 */
export function CustomAirframeField(props: {
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const trimmed = props.value.trim()
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="flex flex-col items-start gap-1.5">
        {t('aircraftForm.customAirframeProfile')}
        <Input type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      </Label>
      {trimmed !== '' && !/^\d+_\d+$/.test(trimmed) && (
        <p className="text-xs text-amber-600 dark:text-amber-500">{t('aircraftForm.airframeIdWarning')}</p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => runAsync('aircraft form: open airframes page', window.winglog.dispatchOpenSimBriefAirframes(trimmed || null))}
      >
        {t('aircraftForm.openAirframesPage')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('aircraftForm.customAirframeHint')}</p>
    </div>
  )
}
