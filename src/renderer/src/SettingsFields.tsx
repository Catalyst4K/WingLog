import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AltitudeUnit, AppLanguage, LandingDistanceUnit, MapLanguage, TrackingSettings, WeightUnit, WindSpeedUnit } from '@shared/ipc'
import { APP_LANGUAGE_OPTIONS } from '@shared/app-language'
import { MAP_LANGUAGES } from './map-labels'
import { trackingLabels } from './trackingLabels'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * Settings controls shared by Settings and the first-launch setup (flightdeck-backend's
 * docs/plans/first-launch-setup.md), so the two can never drift apart.
 */

/** Label above an equal-width button group, one row of the UI page's Units/Theme cards
 *  (docs/plans/settings-ui-page.md) — replaces the old label-beside-buttons rows, whose
 *  button groups started at three different x positions depending on label length. Every
 *  button gets the same min-width so a two-option row and a three-option row read as the
 *  same kind of control.
 *
 *  An optional `hint` moves what used to be an always-visible paragraph under the row into
 *  an info-icon popover instead (flightdeck-backend docs/plans/v1-2.md Part 4) — the Units
 *  card previously stacked five of these paragraphs at once, reading as mostly caveats
 *  rather than mostly controls. Reuses `LandingScoreBreakdownDialog`'s existing
 *  Info+Popover pattern rather than a new one. */
export function SegmentedRow<T extends string>(props: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
  hint?: string
  hintAriaLabel?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <span className="text-sm text-muted-foreground">{props.label}</span>
        {props.hint && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="cursor-pointer text-muted-foreground/60 hover:text-foreground"
                aria-label={props.hintAriaLabel}
              >
                <Info className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent>{props.hint}</PopoverContent>
          </Popover>
        )}
      </div>
      {/* Grouped and labelled so two rows with overlapping option labels (App language and
       *  Map language both offer "Deutsch", "Español", etc.) can still be queried
       *  unambiguously, in tests and by assistive tech alike. */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={props.label}>
        {props.options.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant={props.value === opt.value ? 'default' : 'outline'}
            aria-pressed={props.value === opt.value}
            className="min-w-[4.5rem]"
            onClick={() => props.onChange(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    </div>
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

/** The Units card's rows: weights, OFP altitudes, app and map language, wind, landing distances. */
export function UnitsFields(props: UnitsFieldsProps): React.JSX.Element {
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
      {/* No popover here, unlike the rows below — "Hybrid" isn't a self-explanatory
       *  option the way Feet/Meters are, so its explanation is what the option
       *  *means*, not a supplementary caveat. Hiding it behind a click was a
       *  regression (Callum, 2026-09-23), not a decluttering win. */}
      <div className="flex flex-col gap-1.5">
        <SegmentedRow
          label={t('settingsView.units.ofpAltitudes')}
          value={props.altitudeUnit}
          options={[
            { value: 'ft', label: t('settingsView.units.feet') },
            { value: 'm', label: t('settingsView.units.meters') },
            { value: 'hybrid', label: t('settingsView.units.hybrid') }
          ]}
          onChange={props.onAltitudeUnitChange}
        />
        <p className="text-xs text-muted-foreground">{t('settingsView.units.hybridHint')}</p>
      </div>
      <SegmentedRow
        label={t('settingsView.units.appLanguage')}
        value={props.appLanguage}
        options={APP_LANGUAGE_OPTIONS}
        onChange={props.onAppLanguageChange}
        hint={t('settingsView.units.appLanguageHint')}
        hintAriaLabel={t('settingsView.units.moreInfoFor', { label: t('settingsView.units.appLanguage') })}
      />
      <SegmentedRow
        label={t('settingsView.units.mapLanguage')}
        value={props.mapLanguage}
        options={MAP_LANGUAGES}
        onChange={props.onMapLanguageChange}
        hint={t('settingsView.units.mapLanguageHint')}
        hintAriaLabel={t('settingsView.units.moreInfoFor', { label: t('settingsView.units.mapLanguage') })}
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
        hintAriaLabel={t('settingsView.units.moreInfoFor', { label: t('settingsView.units.landingDistances') })}
      />
    </>
  )
}

/** Automatic tracking start and finish (tracking-auto-toggles.md), each with what turning it
 *  off means. Reads and saves its own setting. */
export function TrackingFields(): React.JSX.Element {
  const { t } = useTranslation()
  const [tracking, setTracking] = useState<TrackingSettings>({ autoStart: true, autoFinish: true })
  useEffect(() => {
    window.winglog.settingsGetTracking().then(setTracking)
  }, [])

  async function handleTrackingChange(next: TrackingSettings): Promise<void> {
    setTracking(next)
    await window.winglog.settingsSetTracking(next)
  }

  const labels = trackingLabels(t)
  return (
    <>
      {(['autoStart', 'autoFinish'] as const).map((key) => (
        <div key={key} className="flex flex-col gap-1">
          <SegmentedRow
            label={t(`settingsView.tracking.${key}`)}
            value={tracking[key] ? 'on' : 'off'}
            options={[
              { value: 'on', label: t('settingsView.tracking.on') },
              { value: 'off', label: t('settingsView.tracking.off') }
            ]}
            onChange={(value) => void handleTrackingChange({ ...tracking, [key]: value === 'on' })}
          />
          <p className="text-xs text-muted-foreground">{t(`settingsView.tracking.${key}Off`, labels)}</p>
        </div>
      ))}
    </>
  )
}
