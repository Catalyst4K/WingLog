/** The Settings tab. Each card's state is a hook in settings/use-settings-state.ts; the cards are in settings/. */

import { winglogApi } from './data/winglog-api'
import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type {
  AltitudeUnit,
  AppLanguage,
  LandingDistanceUnit,
  MapLanguage,
  Theme,
  WeightUnit,
  WindSpeedUnit
} from '@shared/ipc'
import { SegmentedRow, TrackingFields, UnitsFields } from './SettingsFields'
import { trackingLabels } from './tracking-labels'
import { UpdatesCard } from './UpdatesCard'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useResetSignal } from './hooks/use-reset-signal'
import { asyncHandler, runAsync } from './report-error'
import { BeyondAtcCard, CredentialsCard, GsxCard, GsxRemoteCard } from './settings/AddonCards'
import { CloudSyncCard, DataCard } from './settings/DataCards'
import {
  useBeyondAtcSettings,
  useCloudSync,
  useDataTransfer,
  useGsxRemoteSettings,
  useGsxSettings,
  useSimbriefCredentials
} from './settings/use-settings-state'

type SettingsCategory = 'ui' | 'thirdParty' | 'data' | 'about'
const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'ui'

/**
 * @param t The translation function.
 * @returns The categories down the side, in order.
 */
function settingsCategories(t: TFunction): { value: SettingsCategory; label: string }[] {
  return [
    { value: 'ui', label: t('settingsView.categories.ui') },
    { value: 'thirdParty', label: t('settingsView.categories.thirdParty') },
    { value: 'data', label: t('settingsView.categories.data') },
    { value: 'about', label: t('settingsView.categories.about') }
  ]
}

/** The unit, language and theme settings App owns, with their change handlers. */
interface AppWideSettings {
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
  theme: Theme
  onThemeChange: (theme: Theme) => void
}

/**
 * Settings → UI: units and languages, theme, and automatic tracking.
 *
 * @param props The app-wide settings and their change handlers.
 * @returns The element.
 */
function InterfacePanel(props: AppWideSettings): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t('settingsView.units.cardTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <UnitsFields
            weightUnit={props.weightUnit}
            onWeightUnitChange={props.onWeightUnitChange}
            altitudeUnit={props.altitudeUnit}
            onAltitudeUnitChange={props.onAltitudeUnitChange}
            windSpeedUnit={props.windSpeedUnit}
            onWindSpeedUnitChange={props.onWindSpeedUnitChange}
            landingDistanceUnit={props.landingDistanceUnit}
            onLandingDistanceUnitChange={props.onLandingDistanceUnitChange}
            mapLanguage={props.mapLanguage}
            onMapLanguageChange={props.onMapLanguageChange}
            appLanguage={props.appLanguage}
            onAppLanguageChange={props.onAppLanguageChange}
          />
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t('settingsView.theme.cardTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <SegmentedRow
            label={t('settingsView.theme.appearance')}
            value={props.theme}
            options={[
              { value: 'light', label: t('settingsView.theme.light') },
              { value: 'dark', label: t('settingsView.theme.dark') },
              { value: 'system', label: t('settingsView.theme.system') }
            ]}
            onChange={props.onThemeChange}
          />
        </CardContent>
      </Card>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{t('settingsView.tracking.cardTitle')}</CardTitle>
          <CardDescription>{t('settingsView.tracking.description', trackingLabels(t))}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TrackingFields />
        </CardContent>
      </Card>
    </>
  )
}

/**
 * Settings → About: the version, the disclaimer, the manual and the setup.
 *
 * @param props The app version, and the handler that reruns the setup.
 * @returns The element.
 */
function AboutCard(props: { appVersion: string; onRunSetup?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>WingLog{props.appVersion ? ` v${props.appVersion}` : ''}</CardTitle>
        <CardDescription>{t('settingsView.about.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm font-medium text-foreground">{t('settingsView.about.simulationOnly')}</p>
        <p className="text-sm text-foreground">{t('settingsView.about.disclaimer')}</p>
        <p className="text-xs text-muted-foreground">
          {t('settingsView.about.license')}{' '}
          <button
            type="button"
            onClick={asyncHandler('SettingsView appOpenGithub', () => winglogApi().appOpenGithub())}
            className="cursor-pointer underline underline-offset-2 hover:text-foreground"
          >
            github.com/Catalyst4K/WingLog
          </button>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={asyncHandler('SettingsView appOpenManual', async () => {
              if (!(await winglogApi().appOpenManual())) toast.error(t('settingsView.about.manualMissing'))
            })}
          >
            {t('settingsView.about.openManual')}
          </Button>
          {props.onRunSetup && (
            <Button type="button" variant="outline" size="sm" onClick={props.onRunSetup}>
              {t('settingsView.about.runSetup')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The Settings tab.
 *
 * @param props Each app-wide setting and its change handler.
 * @returns The element.
 */
export function SettingsView(
  props: AppWideSettings & {
    /** Mirrors this toggle's live value up to App.tsx, which gates the GSX Remote Control tab
     *  on it — App.tsx doesn't otherwise see this card's own settings
     *  state, which lives entirely in this component. */
    onGsxRemoteEnabledChange: (enabled: boolean) => void
    /** Same reasoning as onGsxRemoteEnabledChange, for the BeyondATC tab. */
    onBeyondAtcEnabledChange: (enabled: boolean) => void
    /** Settings → About → "Run setup again" reopens the first-launch setup. */
    onRunSetup?: () => void
    /** Bumped by App.tsx when the Settings tab is clicked while already active — returns to
     *  the first category (docs/plans/navigation-tab-behaviour.md). See useResetSignal. */
    resetSignal?: number
  }
): React.JSX.Element {
  const { t } = useTranslation()
  // Called in the order the settings used to load in, so the IPC calls go out in that order.
  const credentials = useSimbriefCredentials()
  const gsx = useGsxSettings()
  const gsxRemote = useGsxRemoteSettings(props.onGsxRemoteEnabledChange)
  const beyondAtc = useBeyondAtcSettings(props.onBeyondAtcEnabledChange)
  const sync = useCloudSync()
  const data = useDataTransfer()
  const [appVersion, setAppVersion] = useState('')
  // Purely transient UI state, not persisted — this app has no routing beyond the top tab
  // bar, no reason to add any for a sub-navigation within one of its pages.
  const [category, setCategory] = useState<SettingsCategory>(DEFAULT_SETTINGS_CATEGORY)
  useResetSignal(props.resetSignal, () => setCategory(DEFAULT_SETTINGS_CATEGORY))

  useEffect(() => {
    runAsync('SettingsView appGetVersion', winglogApi().appGetVersion().then(setAppVersion))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold text-foreground">{t('settingsView.title')}</h1>

      <Tabs
        orientation="vertical"
        value={category}
        onValueChange={(value) => setCategory(value as SettingsCategory)}
        className="items-start gap-6"
      >
        <TabsList variant="line" className="w-40 shrink-0 self-stretch border-r border-border/40 pr-3">
          {settingsCategories(t).map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
              {category === value && (
                <ChevronRight data-testid="settings-active-chevron" className="ml-auto" />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="ui" className="flex min-w-0 flex-col gap-4">
          <InterfacePanel {...props} />
        </TabsContent>

        <TabsContent value="thirdParty" className="min-w-0">
          <div className="flex flex-wrap gap-4">
            <CredentialsCard credentials={credentials} />
            <GsxCard gsx={gsx} />
            <GsxRemoteCard gsxRemote={gsxRemote} />
            <BeyondAtcCard beyondAtc={beyondAtc} />
          </div>
        </TabsContent>

        <TabsContent value="data" className="min-w-0">
          <div className="flex flex-wrap gap-4">
            <DataCard data={data} />
            {/* Cloud sync build-time flag (docs/plans/public-release-v1.md, Decision 1) —
                hidden entirely in a public build, not just disabled: the syncLogin/etc.
                channels this card calls don't exist there at all (see index.ts). */}
            {/* v8 ignore next -- vitest.config.ts's `define` fixes the flag at `true`, so the
                "hidden in a public build" arm of this && can't be exercised in this test run. */}
            {__WINGLOG_CLOUD_SYNC_ENABLED__ && <CloudSyncCard sync={sync} />}
          </div>
        </TabsContent>

        <TabsContent value="about" className="flex min-w-0 flex-col gap-4">
          <AboutCard appVersion={appVersion} onRunSetup={props.onRunSetup} />
          <UpdatesCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}
