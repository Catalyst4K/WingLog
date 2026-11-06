/**
 * Settings controls shared by Settings and the first-launch setup (winglog-backend's
 * docs/plans/first-launch-setup.md), so the two can never drift apart.
 */

import { winglogApi } from './data/winglog-api'
import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AltitudeUnit,
  AppLanguage,
  LandingDistanceUnit,
  MapLanguage,
  TrackingSettings,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { APP_LANGUAGE_OPTIONS } from '@shared/app-language'
import { MAP_LANGUAGES } from './map-labels'
import { trackingLabels } from './tracking-labels'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { runAsync } from './report-error'
import { SegmentButton, SegmentedGroup, SettingRow } from './settings/ui/SettingsCard'

/**
 * One row of option buttons, laid out as every other Settings row is (SettingRow): the label (with an optional visible note, or an
 * info-icon popover for a caveat) beside the buttons, or above them when there are more than three options. Every button gets the
 * same min-width so a two-option row and a three-option row read as the same kind of control. A hint is for caveats only; what an
 * option *means* is a note, always visible (docs/plans/v1-2.md Part 4, settings-layout.md).
 *
 * @param props The label, options, value, change handler, and an optional note or hint.
 * @returns The element.
 */
export function SegmentedRow<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  note?: string
  hint?: string
  hintAriaLabel?: string
}): React.JSX.Element {
  return (
    <SettingRow
      label={props.label}
      note={props.note}
      stacked={props.options.length > 3}
      labelAddOn={props.hint && <HintPopover hint={props.hint} ariaLabel={props.hintAriaLabel} />}
    >
      {/* Grouped and labelled so two rows with overlapping option labels (App language and
       *  Map language both offer "Deutsch", "Español", etc.) can still be queried
       *  unambiguously, in tests and by assistive tech alike. */}
      <SegmentedGroup label={props.label}>
        {props.options.map((opt) => (
          <SegmentButton
            key={opt.value}
            pressed={props.value === opt.value}
            onClick={() => props.onChange(opt.value)}
          >
            {opt.label}
          </SegmentButton>
        ))}
      </SegmentedGroup>
    </SettingRow>
  )
}

/**
 * The (i) beside a label: a caveat in a popover.
 *
 * @param props The caveat and the button's accessible name.
 * @returns The element.
 */
function HintPopover(props: { hint: string; ariaLabel?: string }): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="cursor-pointer text-muted-foreground/60 hover:text-foreground"
          aria-label={props.ariaLabel}
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent>{props.hint}</PopoverContent>
    </Popover>
  )
}

/**
 * A setting with many choices (the languages), as the canvas draws it: the label and its note on the left, a dropdown on the right.
 *
 * @param props The label, the choices, the chosen one, the change handler, and an optional note or hint.
 * @returns The element.
 */
export function SelectRow<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  note?: string
  hint?: string
  hintAriaLabel?: string
}): React.JSX.Element {
  return (
    <SettingRow
      label={props.label}
      note={props.note}
      labelAddOn={props.hint && <HintPopover hint={props.hint} ariaLabel={props.hintAriaLabel} />}
    >
      <Select value={props.value} onValueChange={(value) => props.onChange(value as T)}>
        <SelectTrigger aria-label={props.label} className="h-10 min-w-52 justify-between text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  )
}

export interface UnitsFieldsProps {
  weightUnit: WeightUnit
  onWeightUnitChange: (unit: WeightUnit) => void
  altitudeUnit: AltitudeUnit
  onAltitudeUnitChange: (unit: AltitudeUnit) => void
  windSpeedUnit: WindSpeedUnit
  onWindSpeedUnitChange: (unit: WindSpeedUnit) => void
  landingDistanceUnit: LandingDistanceUnit
  onLandingDistanceUnitChange: (unit: LandingDistanceUnit) => void
  mapLanguage: MapLanguage
  onMapLanguageChange: (language: MapLanguage) => void
  appLanguage: AppLanguage
  onAppLanguageChange: (language: AppLanguage) => void
}

/**
 * The Units card's rows: weights, OFP altitudes, app and map language, wind, landing distances.
 *
 * @param props Each unit setting and its change handler.
 * @returns The element.
 */
export function UnitsFields(props: UnitsFieldsProps): React.JSX.Element {
  return (
    <>
      <UnitRows {...props} />
      <LanguageRows {...props} />
    </>
  )
}

/**
 * The unit rows: weights, OFP altitudes, wind, landing distances.
 *
 * @param props Each unit setting and its change handler.
 * @returns The element.
 */
export function UnitRows(props: UnitsFieldsProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <SegmentedRow
        label={t('settingsView.units.weights')}
        value={props.weightUnit}
        options={[
          { value: 'kg', label: 'kg' },
          { value: 'lb', label: 'lb' }
        ]}
        onChange={props.onWeightUnitChange}
      />
      {/* A note, not a popover, unlike the rows below — "Hybrid" isn't a self-explanatory
       *  option the way Feet/Meters are, so its explanation is what the option
       *  *means*, not a supplementary caveat. Hiding it behind a click was a
       *  regression, not a decluttering win. */}
      <SegmentedRow
        label={t('settingsView.units.ofpAltitudes')}
        value={props.altitudeUnit}
        options={[
          { value: 'ft', label: t('settingsView.units.feet') },
          { value: 'm', label: t('settingsView.units.meters') },
          { value: 'hybrid', label: t('settingsView.units.hybrid') }
        ]}
        onChange={props.onAltitudeUnitChange}
        note={t('settingsView.units.hybridHint')}
      />
      <SegmentedRow
        label={t('settingsView.units.metarWindSpeed')}
        value={props.windSpeedUnit}
        options={[
          { value: 'kt', label: t('settingsView.units.knots') },
          { value: 'mps', label: 'm/s' }
        ]}
        onChange={props.onWindSpeedUnitChange}
        hint={t('settingsView.units.metarWindSpeedHint')}
        hintAriaLabel={t('settingsView.units.moreInfoFor', { label: t('settingsView.units.metarWindSpeed') })}
      />
      <SegmentedRow
        label={t('settingsView.units.landingDistances')}
        value={props.landingDistanceUnit}
        options={[
          { value: 'ft', label: t('settingsView.units.feet') },
          { value: 'm', label: t('settingsView.units.meters') }
        ]}
        onChange={props.onLandingDistanceUnitChange}
        hint={t('settingsView.units.landingDistancesHint')}
        hintAriaLabel={t('settingsView.units.moreInfoFor', {
          label: t('settingsView.units.landingDistances')
        })}
      />
    </>
  )
}

/**
 * The language rows: the app's and the map's.
 *
 * @param props The two languages and their change handlers.
 * @returns The element.
 */
export function LanguageRows(
  props: Pick<UnitsFieldsProps, 'appLanguage' | 'onAppLanguageChange' | 'mapLanguage' | 'onMapLanguageChange'>
): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <SelectRow
        label={t('settingsView.units.appLanguage')}
        value={props.appLanguage}
        options={APP_LANGUAGE_OPTIONS}
        onChange={props.onAppLanguageChange}
        hint={t('settingsView.units.appLanguageHint')}
        hintAriaLabel={t('settingsView.units.moreInfoFor', { label: t('settingsView.units.appLanguage') })}
      />
      <SelectRow
        label={t('settingsView.units.mapLanguage')}
        value={props.mapLanguage}
        options={MAP_LANGUAGES}
        onChange={props.onMapLanguageChange}
        hint={t('settingsView.units.mapLanguageHint')}
        hintAriaLabel={t('settingsView.units.moreInfoFor', { label: t('settingsView.units.mapLanguage') })}
      />
    </>
  )
}

/**
 * Automatic tracking start and finish (tracking-auto-toggles.md), each with what turning it
 * off means. Reads and saves its own setting.
 *
 * @returns The element.
 */
export function TrackingFields(): React.JSX.Element {
  const { t } = useTranslation()
  const [tracking, setTracking] = useState<TrackingSettings>({ autoStart: true, autoFinish: true })
  useEffect(() => {
    runAsync('SettingsFields settingsGetTracking', winglogApi().settingsGetTracking().then(setTracking))
  }, [])

  async function handleTrackingChange(next: TrackingSettings): Promise<void> {
    setTracking(next)
    await winglogApi().settingsSetTracking(next)
  }

  const labels = trackingLabels(t)
  return (
    <>
      {(['autoStart', 'autoFinish'] as const).map((key) => (
        <SegmentedRow
          key={key}
          label={t(`settingsView.tracking.${key}`)}
          value={tracking[key] ? 'on' : 'off'}
          options={[
            { value: 'on', label: t('settingsView.tracking.on') },
            { value: 'off', label: t('settingsView.tracking.off') }
          ]}
          onChange={(value) =>
            runAsync(
              'settings: change tracking',
              handleTrackingChange({ ...tracking, [key]: value === 'on' })
            )
          }
          note={t(`settingsView.tracking.${key}Off`, labels)}
        />
      ))}
    </>
  )
}
